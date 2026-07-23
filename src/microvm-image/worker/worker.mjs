// In-MicroVM worker for the Claude self-hosted sandbox.
//
// Supports both Anthropic auth models, selected by the dispatch payload:
//   - First-party Claude API (api.anthropic.com): the payload carries
//     ENVIRONMENT_KEY_PARAM_NAME — a *reference* to the SSM SecureString
//     holding the environment key. The worker fetches it (VM execution role)
//     and authenticates with it as a bearer token.
//   - Claude Platform on AWS (aws-external-anthropic gateway): the payload
//     carries ANTHROPIC_AWS_WORKSPACE_ID (no secret). The worker SigV4-signs
//     requests — as the VM execution role directly, or, when
//     ANTHROPIC_ACCESS_ROLE_ARN is present, as that assumed cross-account role
//     (auto-refreshing STS credentials).
//
// Lifecycle hooks are served as HTTP endpoints on port 9000:
//   POST /aws/lambda-microvms/runtime/v1/ready     (image build: snapshot gate)
//   POST /aws/lambda-microvms/runtime/v1/validate  (post-build smoke test)
//   POST /aws/lambda-microvms/runtime/v1/run       (once, after run from snapshot)
//   POST /aws/lambda-microvms/runtime/v1/resume    (after SUSPENDED -> RUNNING)
//   POST /aws/lambda-microvms/runtime/v1/suspend   (before RUNNING -> SUSPENDED)
//   POST /aws/lambda-microvms/runtime/v1/terminate (before termination)
//
// The /run hook receives the dispatch payload (session id, environment id,
// region, and the auth parameters). It acknowledges immediately (200) then:
//   1. Builds the mode-appropriate client (first-party environment key fetched
//      from SSM, or SigV4 for Claude Platform on AWS).
//   2. Polls the work queue for the matching session.
//   3. Handles the session's tool calls.
//   4. Terminates the MicroVM (TerminateMicrovm) to release compute at once;
//      the idle policy is only the fallback if the call can't be made.

import http from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicAws } from "@anthropic-ai/aws-sdk";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { LambdaMicrovmsClient, TerminateMicrovmCommand } from "@aws-sdk/client-lambda-microvms";
import { fromTemporaryCredentials } from "@aws-sdk/credential-providers";
import { EnvironmentWorker } from "@anthropic-ai/sdk/helpers/beta/environments";
import { betaAgentToolset20260401 } from "@anthropic-ai/sdk/tools/agent-toolset/node";

// Hook server config.
const HOOK_PORT = Number(process.env.HOOK_PORT || 9000);
const HOOK_HOST = "0.0.0.0";
const HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1";

// Debug mode: WORKER_DEBUG=1 logs everything flowing into this VM — every
// lifecycle-hook request and body, the parsed /run dispatch, each work-poll
// cycle (items seen, filter decisions, empty drains, retries), and every tool
// call the agent executes (name + input + result preview) — to CloudWatch. Off
// by default: payloads and tool inputs/outputs may contain sensitive data.
const WORKER_DEBUG = process.env.WORKER_DEBUG === "1";
const DEBUG_RESULT_PREVIEW_CHARS = 400;

// Structured debug line. No-op unless WORKER_DEBUG=1. `data` is JSON-stringified
// with a size cap so a huge payload can't blow up a log event.
function dbg(event, data) {
  if (!WORKER_DEBUG) return;
  if (data === undefined) {
    console.log(`worker[debug]: ${event}`);
    return;
  }
  let rendered;
  try {
    rendered = typeof data === "string" ? data : JSON.stringify(data);
  } catch (err) {
    rendered = `<unserializable: ${err?.message || err}>`;
  }
  const MAX = 4000;
  if (rendered.length > MAX) rendered = `${rendered.slice(0, MAX)}…(+${rendered.length - MAX} chars)`;
  console.log(`worker[debug]: ${event} ${rendered}`);
}

// Wrap each runnable tool so its invocations are logged before/after execution.
function withDebugLogging(tools) {
  return tools.map((tool) => ({
    ...tool,
    run: async (input, context) => {
      console.log(`worker[debug]: tool=${tool.name} input=${JSON.stringify(input)}`);
      try {
        const result = await tool.run(input, context);
        const preview =
          typeof result === "string" ? result : JSON.stringify(result);
        console.log(
          `worker[debug]: tool=${tool.name} ok result=${preview.slice(0, DEBUG_RESULT_PREVIEW_CHARS)}${preview.length > DEBUG_RESULT_PREVIEW_CHARS ? "…" : ""}`,
        );
        return result;
      } catch (err) {
        console.error(`worker[debug]: tool=${tool.name} FAILED:`, err);
        throw err;
      }
    },
  }));
}

// The EnvironmentWorker helper requires an environmentKey string and clones
// the client with `authToken: environmentKey`. AnthropicAws in SigV4 mode
// intentionally supersedes any clone-supplied authToken (the gateway
// authenticates the SigV4 identity), so in AWS mode this placeholder satisfies
// the helper without ever reaching the wire.
const SIGV4_PLACEHOLDER_KEY = "unused-sigv4-auth";

let sessionStarted = false; // guard: handle the session at most once per VM

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function fetchEnvironmentKey(parameterName, region) {
  const client = new SSMClient({ region });
  const result = await client.send(
    new GetParameterCommand({ Name: parameterName, WithDecryption: true }),
  );
  const value = result.Parameter?.Value;
  if (!value) {
    throw new Error(`SSM parameter ${parameterName} has no value`);
  }
  return value;
}

// Build the client + helper credential for the auth mode the dispatch selects.
async function buildClient(dispatch) {
  const sessionId = dispatch.ANTHROPIC_SESSION_ID;
  const region = dispatch.AWS_REGION;
  const baseURL = dispatch.ANTHROPIC_BASE_URL || undefined;

  if (dispatch.ENVIRONMENT_KEY_PARAM_NAME) {
    // First-party mode: bearer environment key fetched from SSM by reference.
    console.log("worker: auth mode = environment key (first-party Claude API)");
    const environmentKey = await fetchEnvironmentKey(dispatch.ENVIRONMENT_KEY_PARAM_NAME, region);
    return { client: new Anthropic({ authToken: environmentKey, baseURL }), environmentKey };
  }

  // Claude Platform on AWS: SigV4. Cross-account when an access role is given —
  // fromTemporaryCredentials auto-refreshes before the STS expiry, so sessions
  // can outlive the 1-hour credential lifetime. The region-derived base URL
  // targets the aws-external-anthropic gateway; baseURL is an optional override.
  const accessRoleArn = dispatch.ANTHROPIC_ACCESS_ROLE_ARN;
  console.log(`worker: auth mode = SigV4 (Claude Platform on AWS${accessRoleArn ? ", cross-account" : ""})`);
  const client = new AnthropicAws({
    awsRegion: region,
    workspaceId: dispatch.ANTHROPIC_AWS_WORKSPACE_ID,
    baseURL,
    ...(accessRoleArn && {
      providerChainResolver: async () => {
        const provider = fromTemporaryCredentials({
          params: {
            RoleArn: accessRoleArn,
            RoleSessionName: `microvm-${sessionId}`.slice(0, 64),
          },
          clientConfig: { region },
        });
        // Surface the real failure (IMDS, STS AccessDenied, ...) — the SDK wraps
        // provider errors in a generic "failed to resolve credentials" message.
        return async () => {
          try {
            return await provider();
          } catch (err) {
            console.error(`worker: assume-role ${accessRoleArn} failed:`, err);
            throw err;
          }
        };
      },
    }),
  });
  return { client, environmentKey: SIGV4_PLACEHOLDER_KEY };
}

// How long to keep polling for the session's (next) work item before exiting.
// This serves two purposes:
//   - Startup race: the webhook races work-item creation, so a snapshot-booted
//     VM can poll before the item is claimable — one drain pass isn't enough.
//   - VM reuse: every agent turn emits another run_started webhook. The
//     launcher dedupes on session id for SESSION_DEDUPE_TTL_SECONDS (300s), so
//     this VM must keep serving the session's next turns for LONGER than that
//     TTL — otherwise a turn arriving after the worker exits but before the
//     dedupe record expires would be dropped. 360s > 300s keeps the handoff
//     gap-free; the deadline resets after each handled turn.
const WORK_IDLE_EXIT_MS = Number(process.env.WORK_IDLE_EXIT_MS || 360_000);
const WORK_WAIT_RETRY_MS = 3_000;

// Serve the session named in the dispatch: handle its work items as turns
// arrive, exiting only after WORK_IDLE_EXIT_MS with no new work.
async function handleSession(dispatch) {
  const sessionId = dispatch.ANTHROPIC_SESSION_ID;
  const environmentId = dispatch.ANTHROPIC_ENVIRONMENT_ID;

  const { client, environmentKey } = await buildClient(dispatch);
  const worker = new EnvironmentWorker({
    client,
    environmentId,
    environmentKey,
    workdir: "/workspace",
    // In debug mode, bind the standard toolset ourselves so every tool call
    // (bash command, file read/write, ...) is logged around execution.
    ...(WORKER_DEBUG && {
      tools: (ctx) => withDebugLogging(betaAgentToolset20260401(ctx)),
    }),
  });
  if (WORKER_DEBUG) console.log("worker: debug mode ON — logging all tool calls");

  console.log(`worker: serving session ${sessionId}`);
  dbg("serve.config", {
    sessionId,
    environmentId,
    workIdleExitMs: WORK_IDLE_EXIT_MS,
    workWaitRetryMs: WORK_WAIT_RETRY_MS,
  });

  // Poll the environment work queue with the RAW poll endpoint — deliberately
  // NOT the WorkPoller helper. The queue is environment-wide and this VM is
  // pinned to one session, but WorkPoller acks (= permanently claims) every
  // item BEFORE yielding it, so a session-pinned consumer that skips a foreign
  // item would consume another session's turn and drop it — that session's VM
  // then starves and its Console hangs. The raw poll only leases the item:
  // left un-acked, the server reclaims it after reclaim_older_than_ms and the
  // right VM picks it up. We ack only items that belong to OUR session, then
  // hand them to EnvironmentWorker.handleItem (which heartbeats the lease and
  // force-stops the item on exit).
  //
  // Poll/ack authenticate as the environment. Our client already carries the
  // right credential for the mode — buildClient returns first-party clients
  // constructed with `authToken: environmentKey`, and AnthropicAws signs with
  // SigV4 — so no helper-style re-auth clone is needed here.
  const pollClient = client;

  let handled = 0;
  let pollCycle = 0;
  let foreignSeen = 0;
  let idleDeadline = Date.now() + WORK_IDLE_EXIT_MS;
  do {
    pollCycle += 1;
    let work = null;
    try {
      // block_ms: server-side long poll (API caps it at 999ms) so an empty
      // queue doesn't busy-spin; reclaim_older_than_ms: how stale an un-acked
      // lease must be before the server hands the item out again.
      work = await pollClient.beta.environments.work.poll(environmentId, {
        block_ms: 999,
        reclaim_older_than_ms: 2000,
      });
    } catch (err) {
      dbg("poll.error", { cycle: pollCycle, message: err?.message || String(err), status: err?.status });
      if (WORKER_DEBUG) console.error("worker[debug]: poll threw:", err);
      // Transient failure — wait and retry until the idle deadline.
      await new Promise((r) => setTimeout(r, WORK_WAIT_RETRY_MS));
      continue;
    }

    if (work == null) {
      dbg("poll.empty", { cycle: pollCycle, msToDeadline: idleDeadline - Date.now() });
      await new Promise((r) => setTimeout(r, WORK_WAIT_RETRY_MS));
      continue;
    }

    dbg("poll.item", {
      cycle: pollCycle,
      workId: work.id,
      dataType: work.data?.type,
      dataId: work.data?.id,
      state: work.state,
      matchesSession: work.data?.type === "session" && work.data?.id === sessionId,
    });

    if (work.data?.type !== "session" || work.data?.id !== sessionId) {
      // Another session's work (or a non-session item). Do NOT ack and do NOT
      // stop it — leave the lease to expire so its own VM can reclaim it.
      foreignSeen += 1;
      dbg("poll.foreign", {
        cycle: pollCycle,
        workId: work.id,
        reason: work.data?.type !== "session" ? "type" : "sessionId",
        action: "left for reclaim",
      });
      // Back off past the reclaim window so we don't immediately re-lease the
      // same foreign item and shut its rightful VM out.
      await new Promise((r) => setTimeout(r, WORK_WAIT_RETRY_MS));
      continue;
    }

    // Ours: claim it for real, then serve the turn.
    try {
      await pollClient.beta.environments.work.ack(work.id, { environment_id: environmentId });
    } catch (err) {
      // Lost the claim race (another VM of this session acked first) or a
      // transient error — either way the item is not ours to run; retry.
      dbg("ack.failed", { cycle: pollCycle, workId: work.id, message: err?.message || String(err), status: err?.status });
      await new Promise((r) => setTimeout(r, WORK_WAIT_RETRY_MS));
      continue;
    }

    console.log(`worker: handling session ${sessionId} (work ${work.id})`);
    await worker.handleItem({ workId: work.id, environmentId, sessionId, environmentKey });
    handled += 1;
    console.log(`worker: session ${sessionId} turn complete (${handled} handled); waiting for next turn`);
    idleDeadline = Date.now() + WORK_IDLE_EXIT_MS;
  } while (Date.now() < idleDeadline);
  console.log(
    `worker: session ${sessionId} idle for ${WORK_IDLE_EXIT_MS}ms after ${handled} turn(s) over ${pollCycle} poll cycle(s) (${foreignSeen} foreign item(s) left for reclaim); exiting`,
  );
}

// Terminate this MicroVM to release compute as soon as the session finishes.
// The microvm id comes from the /run envelope (not the inner dispatch). Best
// effort: if the call fails, we log and fall back to the idle policy.
async function terminateSelf(microvmId, region) {
  if (!microvmId) {
    console.warn("worker: no microvmId in /run envelope; leaving termination to the idle policy");
    return;
  }
  try {
    const client = new LambdaMicrovmsClient({ region });
    await client.send(new TerminateMicrovmCommand({ microvmIdentifier: microvmId }));
    console.log(`worker: requested termination of microvm ${microvmId}`);
  } catch (err) {
    console.error("worker: terminate-microvm failed; idle policy will reclaim the VM:", err);
  }
}

function ackThenRun(res, dispatch, microvmId) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "accepted" }));
  if (sessionStarted) return;
  sessionStarted = true;
  handleSession(dispatch).then(
    async () => {
      await terminateSelf(microvmId, dispatch.AWS_REGION);
      process.exit(0);
    },
    async (err) => {
      console.error("worker: session failed", err);
      await terminateSelf(microvmId, dispatch.AWS_REGION);
      process.exit(1);
    },
  );
}

const server = http.createServer(async (req, res) => {
  const ok = (body = { status: "ok" }) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  dbg("http.request", { method: req.method, url: req.url });
  if (req.method !== "POST" || !req.url.startsWith(HOOK_PREFIX)) {
    res.writeHead(404);
    res.end();
    return;
  }
  const hook = req.url.slice(HOOK_PREFIX.length + 1); // path part after the prefix

  switch (hook) {
    case "ready": // image build: app initialized, safe to snapshot
    case "validate": // post-build smoke test of the snapshot
    case "resume":
    case "suspend":
    case "terminate":
      // These hooks carry a body too (VM/session metadata); capture it so we
      // can see everything the platform delivers to the VM, not just /run.
      if (WORKER_DEBUG) {
        const raw = await readBody(req);
        dbg("hook.body", { hook, raw });
      }
      ok();
      return;
    case "run": {
      try {
        const raw = await readBody(req);
        dbg("run.raw", { raw });
        const envelope = raw ? JSON.parse(raw) : {};
        // The service wraps the payload: { microvmId, runHookPayload: "<JSON>" }.
        const inner = envelope.runHookPayload
          ? JSON.parse(envelope.runHookPayload)
          : envelope;
        const dispatch = inner.session || inner;
        dbg("run.dispatch", {
          microvmId: envelope.microvmId,
          envelopeKeys: Object.keys(envelope),
          dispatchKeys: Object.keys(dispatch),
          sessionId: dispatch.ANTHROPIC_SESSION_ID,
          environmentId: dispatch.ANTHROPIC_ENVIRONMENT_ID,
          region: dispatch.AWS_REGION,
        });
        if (!dispatch.ANTHROPIC_SESSION_ID) {
          console.error("worker: /run hook missing ANTHROPIC_SESSION_ID in payload:", raw);
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "missing ANTHROPIC_SESSION_ID" }));
          return;
        }
        // microvmId lives on the envelope, not the inner dispatch; the worker
        // needs it to terminate itself once the session is done.
        ackThenRun(res, dispatch, envelope.microvmId);
      } catch (err) {
        console.error("worker: /run hook error", err);
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "invalid run payload" }));
      }
      return;
    }
    default:
      res.writeHead(404);
      res.end();
  }
});

server.listen(HOOK_PORT, HOOK_HOST, () => {
  console.log(`worker: hook server listening on ${HOOK_HOST}:${HOOK_PORT}`);
});

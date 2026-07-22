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
import { WorkPoller, EnvironmentWorker } from "@anthropic-ai/sdk/helpers/beta/environments";

// Hook server config.
const HOOK_PORT = Number(process.env.HOOK_PORT || 9000);
const HOOK_HOST = "0.0.0.0";
const HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1";

// The WorkPoller/EnvironmentWorker helpers require an environmentKey string and
// clone the client with `authToken: environmentKey`. AnthropicAws in SigV4 mode
// intentionally supersedes any clone-supplied authToken (the gateway
// authenticates the SigV4 identity), so in AWS mode this placeholder satisfies
// the helpers without ever reaching the wire.
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

// Handle exactly the session named in the dispatch.
async function handleSession(dispatch) {
  const sessionId = dispatch.ANTHROPIC_SESSION_ID;
  const environmentId = dispatch.ANTHROPIC_ENVIRONMENT_ID;

  const { client, environmentKey } = await buildClient(dispatch);
  const worker = new EnvironmentWorker({ client, environmentId, environmentKey, workdir: "/workspace" });

  console.log(`worker: looking for work item for session ${sessionId}`);
  const poller = new WorkPoller({
    client,
    environmentId,
    environmentKey,
    reclaimOlderThanMs: 2000,
    drain: true,
    autoStop: false,
  });

  for await (const work of poller) {
    if (work.data.type !== "session" || work.data.id !== sessionId) {
      continue;
    }
    console.log(`worker: handling session ${sessionId} (work ${work.id})`);
    await worker.handleItem({ workId: work.id, environmentId, sessionId, environmentKey });
    console.log(`worker: session ${sessionId} complete`);
    return;
  }
  console.warn(`worker: no work item found for session ${sessionId}`);
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
      ok();
      return;
    case "run": {
      try {
        const raw = await readBody(req);
        const envelope = raw ? JSON.parse(raw) : {};
        // The service wraps the payload: { microvmId, runHookPayload: "<JSON>" }.
        const inner = envelope.runHookPayload
          ? JSON.parse(envelope.runHookPayload)
          : envelope;
        const dispatch = inner.session || inner;
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

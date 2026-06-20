// In-MicroVM worker for the Claude self-hosted sandbox.
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
// secret reference, region). It acknowledges immediately (200) then:
//   1. Fetches the environment key from Secrets Manager (VM execution role).
//   2. Polls the work queue for the matching session.
//   3. Handles the session's tool calls.
//   4. Exits — idle policy drives suspend/terminate.

import http from "node:http";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import Anthropic from "@anthropic-ai/sdk";
import { WorkPoller, EnvironmentWorker } from "@anthropic-ai/sdk/helpers/beta/environments";

// Hook server config.
const HOOK_PORT = Number(process.env.HOOK_PORT || 9000);
const HOOK_HOST = "0.0.0.0";
const HOOK_PREFIX = "/aws/lambda-microvms/runtime/v1";

let sessionStarted = false; // guard: handle the session at most once per VM

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf-8");
}

async function fetchEnvironmentKey(secretId, region) {
  const client = new SecretsManagerClient({ region });
  const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!result.SecretString) {
    throw new Error(`secret ${secretId} has no SecretString`);
  }
  return result.SecretString;
}

// Handle exactly the session named in the dispatch.
async function handleSession(dispatch) {
  const sessionId = dispatch.ANTHROPIC_SESSION_ID;
  const environmentId = dispatch.ANTHROPIC_ENVIRONMENT_ID;
  const secretId = dispatch.ENVIRONMENT_KEY_SECRET_ID;
  const region = dispatch.AWS_REGION;
  const baseURL = dispatch.ANTHROPIC_BASE_URL || undefined;

  const environmentKey = await fetchEnvironmentKey(secretId, region);
  const client = new Anthropic({ authToken: environmentKey, baseURL });
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

function ackThenRun(res, dispatch) {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ status: "accepted" }));
  if (sessionStarted) return;
  sessionStarted = true;
  handleSession(dispatch).then(
    () => process.exit(0), // clean exit; idle policy suspends/terminates the VM
    (err) => {
      console.error("worker: session failed", err);
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
        ackThenRun(res, dispatch);
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

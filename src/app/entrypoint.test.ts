import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ENTRYPOINT = fileURLToPath(new URL("../../entrypoint.sh", import.meta.url));
const run = (env: Record<string, string>) =>
  spawnSync("sh", [ENTRYPOINT, "echo", "RAN"], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, encoding: "utf8" });

// The HTTP-mode server has never had AWS env — the agent's entrypoint, copied as-is, defaults to
// iam-anywhere and would refuse to start every existing mcp-server pod.
test("HTTP mode with no AWS env starts the command and sets up no credentials", () => {
  const r = run({ TRANSPORT: "http" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RAN/);
  assert.match(r.stdout, /skipping credential setup/);
});

test("SQS mode defaults to iam-anywhere and refuses to start without its env", () => {
  const r = run({ TRANSPORT: "sqs" });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /AWS_TRUST_ANCHOR_ARN/);
});

test("an explicit AWS_AUTH_MODE=env is honoured in SQS mode", () => {
  const r = run({ TRANSPORT: "sqs", AWS_AUTH_MODE: "env" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RAN/);
});

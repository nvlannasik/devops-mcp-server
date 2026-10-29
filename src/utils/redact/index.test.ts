import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets } from "./index.js";

// Every tool result leaves the cluster for an LLM provider, the agent's database and its dashboard.
// 2026-10-28: a cloudflared Deployment's args carried its tunnel token, and k8s_get_resource handed
// it out verbatim. All values below are made up.
const BLOB = "eyJhIjoiMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCJ0IjoiZmFrZSJ9";

test("secrets in container args, env values and secret-named keys are masked", () => {
  const { value, hits } = redactSecrets({
    containers: [
      {
        args: ["tunnel", "run", "--token", BLOB],
        command: ["app", "--password=hunter2hunter2"],
        env: [
          { name: "DB_PASSWORD", value: "s3cr3t-value" },
          { name: "GITHUB_TOKEN", value: "ghp_000000000000000000" },
          { name: "DATABASE_URL", value: "postgres://app:pa55word@db:5432/app" },
          { name: "LOG_LEVEL", value: "debug" },
        ],
      },
    ],
    clientSecret: "abcdef123456",
    logs: 'level=info msg="auth ok" token=abcdef123456 Authorization: Bearer abcDEF123456ghiJKL789',
  });
  const c = (value as any).containers[0];
  assert.deepEqual(c.args, ["tunnel", "run", "--token", "[REDACTED]"]);
  assert.deepEqual(c.command, ["app", "--password=[REDACTED]"]);
  assert.equal(c.env[0].value, "[REDACTED]");
  assert.equal(c.env[1].value, "[REDACTED]");
  assert.equal(c.env[2].value, "postgres://app:[REDACTED]@db:5432/app");
  assert.equal(c.env[3].value, "debug");
  assert.equal((value as any).clientSecret, "[REDACTED]");
  assert.equal((value as any).logs, 'level=info msg="auth ok" token=[REDACTED] Authorization: Bearer [REDACTED]');
  assert.ok(hits > 0);
});

test("references to secrets — what the agent reasons about — are kept", () => {
  const input = {
    volumes: [{ name: "tls", secret: { secretName: "workload-tls" } }],
    env: [{ name: "API_TOKEN", valueFrom: { secretKeyRef: { name: "api", key: "token" } } }],
    imagePullSecrets: [{ name: "regcred" }],
    usage: { inputTokens: 1200, tokens: "1200" },
    message: "token expired; see --help for flags",
  };
  const { value, hits } = redactSecrets(input);
  assert.deepEqual(value, input);
  assert.equal(hits, 0);
});

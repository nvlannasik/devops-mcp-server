import { test } from "node:test";
import assert from "node:assert/strict";
import { correlate, factsOf } from "./correlate.js";

const pod = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  facts: new Set<string>(over.facts as string[] ?? []),
  reason: over.reason as string | undefined,
});

// The benchmark case this tool exists for: eight pods broken by one bad DATABASE_URL, failed
// 3/3 attempts because the model never named the shared input. Here it falls out of set algebra.
test("the attribute only the broken pods have is what surfaces", () => {
  const broken = ["a", "b", "c"].map((n) =>
    pod(n, { facts: ["node=w1", "image=orders:v2", "configMap=app-config", "env=DATABASE_URL"], reason: "CrashLoopBackOff" })
  );
  const healthy = [
    pod("h1", { facts: ["node=w1", "image=orders:v2"] }),
    pod("h2", { facts: ["node=w2", "image=orders:v2"] }),
  ];
  const out = correlate({ broken, healthy });

  assert.deepEqual(out.uniqueToBroken, ["configMap=app-config", "env=DATABASE_URL"]);
  // shared-with-healthy is the noise the verdict tells the reader to skip
  assert.ok(out.sharedWithHealthy.includes("image=orders:v2"));
  assert.deepEqual(out.reasons, { CrashLoopBackOff: 3 });
  assert.match(out.verdict, /NO healthy pod/);
});

test("nothing unique is a real answer, not an empty one", () => {
  const broken = [pod("a", { facts: ["node=w1"] }), pod("b", { facts: ["node=w1"] })];
  const healthy = [pod("h1", { facts: ["node=w1"] })];
  const out = correlate({ broken, healthy });
  assert.deepEqual(out.uniqueToBroken, []);
  assert.match(out.verdict, /single shared cause is unlikely/);
  assert.match(out.verdict, /node pressure, an upstream dependency, a recent deploy/);
});

test("with no control group, nothing is singled out — every shared fact would look unique", () => {
  // Caught by this test: the branch order had unique.length > 0 first, so a namespace where
  // EVERY pod is broken reported all of its shared attributes as "no healthy pod has this",
  // which is vacuously true and reads as a finding.
  const out = correlate({ broken: [pod("a", { facts: ["x=1"] }), pod("b", { facts: ["x=1"] })], healthy: [] });
  assert.deepEqual(out.uniqueToBroken, []);
  assert.match(out.verdict, /NO healthy pod in this namespace to compare against/);
});

test("one broken pod says there is nothing to correlate rather than inventing a pattern", () => {
  const out = correlate({ broken: [pod("a", { facts: ["node=w1"] })], healthy: [pod("h", { facts: ["node=w2"] })] });
  assert.match(out.verdict, /nothing to correlate/);
});

test("a field that varies inside the broken set is reported as varying, by name only", () => {
  const broken = [
    pod("a", { facts: ["node=w1", "configMap=app-config"] }),
    pod("b", { facts: ["node=w2", "configMap=app-config"] }),
  ];
  const out = correlate({ broken, healthy: [] });
  assert.deepEqual(out.varyingFields, ["node"]);
  assert.ok(!out.uniqueToBroken.some((f) => f.startsWith("node=")));
});

test("facts come from every place a reference hides, and env VALUES are never included", () => {
  const f = factsOf({
    metadata: { name: "p", ownerReferences: [{ kind: "ReplicaSet", name: "api-7c9" }] },
    spec: {
      nodeName: "w1",
      serviceAccountName: "runner",
      imagePullSecrets: [{ name: "regcred" }],
      volumes: [{ projected: { sources: [{ configMap: { name: "ca" } }] } }],
      containers: [{
        name: "api",
        image: "orders:v2",
        envFrom: [{ configMapRef: { name: "app-config" } }],
        env: [{ name: "DATABASE_URL", valueFrom: { secretKeyRef: { name: "db-creds" } } }],
      }],
    },
  });
  for (const expected of [
    "node=w1", "serviceAccount=runner", "secret=regcred", "configMap=ca",
    "configMap=app-config", "secret=db-creds", "image=orders:v2",
    "env=DATABASE_URL", "ownerKind=ReplicaSet",
  ]) {
    assert.ok(f.has(expected), `missing ${expected}`);
  }
  // The name identifies the shared input; the value could be a credential.
  assert.ok(![...f].some((v) => v.includes("postgres://")));
});

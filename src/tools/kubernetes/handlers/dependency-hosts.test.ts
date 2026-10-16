import { test } from "node:test";
import assert from "node:assert/strict";
import { stripUserinfo, hostsIn, matchHost, envDeps, configMapRefs } from "./dependency-hosts.js";

const SERVICES = new Set(["postgresql/postgresql", "sample-apps/orders-api", "monitoring/jaeger", "sample-apps/postgres"]);

test("userinfo is stripped before anything parses the value", () => {
  assert.equal(stripUserinfo("postgres://app:s3cret@postgresql.postgresql:5432/db"), "postgres://postgresql.postgresql:5432/db");
  assert.equal(stripUserinfo("redis://:pw@redis-master.redis:6379"), "redis://redis-master.redis:6379");
  assert.equal(stripUserinfo("plain-value"), "plain-value");
});

test("hostsIn: URLs, host:port, comma lists; IPs and non-hosts are not hosts", () => {
  assert.deepEqual(hostsIn("postgres://app:s3cret@postgresql.postgresql:5432/db"), ["postgresql.postgresql"]);
  assert.deepEqual(hostsIn("orders-api:8080"), ["orders-api"]);
  assert.deepEqual(hostsIn("kafka-0.kafka:9092,kafka-1.kafka:9092"), ["kafka-0.kafka", "kafka-1.kafka"]);
  assert.deepEqual(hostsIn("10.0.0.12:5432"), []);
  assert.deepEqual(hostsIn("http://jaeger.monitoring.svc.cluster.local:4318"), ["jaeger.monitoring.svc.cluster.local"]);
  // A bare word IS a candidate here — matchHost decides (only a host-ish env name, only a real Service).
  assert.deepEqual(hostsIn("disable"), ["disable"]);
  assert.deepEqual(hostsIn("!!! 123"), []);
});

test("matchHost: svc, svc.ns, svc.ns.svc.cluster.local; unresolved in-cluster; external; a bare word only under a host-ish name", () => {
  assert.deepEqual(matchHost("orders-api", "sample-apps", SERVICES, true), { kind: "service", namespace: "sample-apps", name: "orders-api" });
  assert.deepEqual(matchHost("postgresql.postgresql", "sample-apps", SERVICES, false), { kind: "service", namespace: "postgresql", name: "postgresql" });
  assert.deepEqual(matchHost("postgresql.postgresql.svc.cluster.local", "sample-apps", SERVICES, false), { kind: "service", namespace: "postgresql", name: "postgresql" });
  assert.deepEqual(matchHost("payments.billing.svc.cluster.local", "sample-apps", SERVICES, false), { kind: "unresolved" });
  assert.deepEqual(matchHost("api.stripe.com", "sample-apps", SERVICES, false), { kind: "external" });
  // DB_TYPE=postgres beside a Service named postgres: not a host-ish env name → no edge
  assert.equal(matchHost("postgres", "sample-apps", SERVICES, false), null);
  assert.equal(matchHost("disable", "sample-apps", SERVICES, true), null);
});

test("envDeps: literal env, configMapKeyRef, envFrom configMapRef; secrets never resolved; values never returned", () => {
  const cms = new Map([["sample-apps/app-config", { CACHE_HOST: "redis-master.redis", MODE: "fast" }]]);
  const services = new Set([...SERVICES, "redis/redis-master"]);
  const secretRead: string[] = [];
  const deps = envDeps(
    [
      {
        env: [
          { name: "DATABASE_URL", value: "postgres://app:s3cret@postgresql.postgresql:5432/db" },
          { name: "DB_SSL_MODE", value: "disable" },
          { name: "DB_TYPE", value: "postgres" },
          { name: "ORDERS_HOST", value: "orders-api" },
          { name: "STRIPE_URL", value: "https://api.stripe.com/v1" },
          { name: "PAYMENTS_URL", value: "http://payments.billing.svc.cluster.local" },
          { name: "OTEL_EXPORTER_OTLP_ENDPOINT", value: "http://jaeger.monitoring.svc.cluster.local:4318" },
          { name: "DB_PASSWORD", valueFrom: { get secretKeyRef() { secretRead.push("x"); return { name: "s", key: "k" }; } } },
        ],
        envFrom: [{ configMapRef: { name: "app-config" } }, { secretRef: { name: "app-secrets" } }],
      },
    ],
    "sample-apps",
    services,
    cms
  );
  assert.deepEqual(deps.dependsOn, [
    { service: "postgresql", namespace: "postgresql", via: "DATABASE_URL", role: "app" },
    { service: "orders-api", namespace: "sample-apps", via: "ORDERS_HOST", role: "app" },
    { service: "jaeger", namespace: "monitoring", via: "OTEL_EXPORTER_OTLP_ENDPOINT", role: "telemetry" },
    { service: "redis-master", namespace: "redis", via: "CACHE_HOST", role: "app" },
  ]);
  assert.deepEqual(deps.externalHosts, [{ host: "api.stripe.com", via: "STRIPE_URL" }]);
  assert.deepEqual(deps.unresolved, [{ host: "payments.billing.svc.cluster.local", via: "PAYMENTS_URL" }]);
  assert.equal(secretRead.length, 0, "a secretKeyRef is never even looked at");
  assert.doesNotMatch(JSON.stringify(deps), /s3cret|disable|fast/);
});

test("envDeps with configMaps=null (the read was refused) still reads literal env", () => {
  const deps = envDeps([{ env: [{ name: "DB_HOST", value: "postgresql.postgresql" }], envFrom: [{ configMapRef: { name: "x" } }] }], "sample-apps", SERVICES, null);
  assert.equal(deps.dependsOn.length, 1);
});

test("configMapRefs lists every referenced ConfigMap once, never a Secret", () => {
  assert.deepEqual(
    configMapRefs([{ env: [{ name: "A", valueFrom: { configMapKeyRef: { name: "cfg", key: "a" } } }], envFrom: [{ configMapRef: { name: "cfg" } }, { configMapRef: { name: "other" } }, { secretRef: { name: "s" } }] }], "ns1"),
    ["ns1/cfg", "ns1/other"]
  );
});

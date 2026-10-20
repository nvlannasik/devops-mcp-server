import { test } from "node:test";
import assert from "node:assert/strict";
import { pollRequests } from "./sqs-loop.js";

test("one receive: each message handled with its body and receipt handle, heartbeat touched, abort stops the loop", async () => {
  const ac = new AbortController();
  const handled: Array<[string | undefined, string]> = [];
  let beats = 0;
  let receives = 0;
  const receiveInputs: any[] = [];
  const sqs = {
    send: async (cmd: any) => {
      if (cmd.constructor.name !== "ReceiveMessageCommand") throw new Error(`unexpected ${cmd.constructor.name}`);
      receives++;
      receiveInputs.push(cmd.input);
      if (receives === 1) return { Messages: [{ Body: '{"a":1}', ReceiptHandle: "rh-1" }, { Body: '{"b":2}', ReceiptHandle: "rh-2" }] };
      ac.abort();
      return { Messages: [] };
    },
  };
  await pollRequests(ac.signal, {
    sqs, requestUrl: "https://q/req", concurrency: 4, pollWaitSeconds: 1, visibilitySeconds: 65,
    heartbeat: async () => { beats++; },
    handle: async (body, rh) => { handled.push([body, rh]); },
  });
  assert.deepEqual(handled, [['{"a":1}', "rh-1"], ['{"b":2}', "rh-2"]]);
  assert.ok(beats >= 1);
  assert.equal(receiveInputs[0].VisibilityTimeout, 65, "a slow read is never redelivered mid-run");
  assert.equal(receiveInputs[0].QueueUrl, "https://q/req");
});

test("a handler that throws does not stop the loop", async () => {
  const ac = new AbortController();
  let receives = 0;
  const sqs = {
    send: async () => {
      receives++;
      if (receives === 1) return { Messages: [{ Body: "x", ReceiptHandle: "rh" }] };
      ac.abort();
      return { Messages: [] };
    },
  };
  await pollRequests(ac.signal, {
    sqs, requestUrl: "u", concurrency: 1, pollWaitSeconds: 1, visibilitySeconds: 65,
    heartbeat: async () => {},
    handle: async () => { throw new Error("handler blew up"); },
  });
  assert.ok(receives >= 2);
});

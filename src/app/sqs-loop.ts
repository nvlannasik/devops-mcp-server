// The SQS bridge's receive loop and its wiring (TRANSPORT=sqs). Mirrors llm-worker's pollLoop:
// long poll, a concurrency cap, in-flight bookkeeping, a drain on abort. Every per-message
// rule lives in sqs-bridge.ts.
import {
  SQSClient,
  ReceiveMessageCommand,
  DeleteMessageCommand,
  SendMessageCommand,
  GetQueueUrlCommand,
  CreateQueueCommand,
  QueueDoesNotExist,
} from "@aws-sdk/client-sqs";
import { writeFile } from "fs/promises";
import { logWithContext } from "../utils/logger/log.js";
import config from "../config/index.js";
import allTools from "../tools/index.js";
import writeTools from "../tools/kubernetes/write.js";
import { invokeTool, TOOL_HANDLER_TIMEOUT_MS } from "./invoke.js";
import { handleBridgeMessage } from "./sqs-bridge.js";
import { withSqsConsumerSpan } from "../tracing/sqs.js";
import { untraced } from "../tracing/untraced.js";

export interface PollDeps {
  sqs: { send(cmd: unknown, opts?: unknown): Promise<any> };
  requestUrl: string;
  concurrency: number;
  pollWaitSeconds: number;
  visibilitySeconds: number;
  heartbeat: () => Promise<void>;
  handle: (body: string | undefined, receiptHandle: string) => Promise<void>;
}

export async function pollRequests(signal: AbortSignal, d: PollDeps): Promise<void> {
  const inFlight = new Set<Promise<void>>();
  while (!signal.aborted) {
    await d.heartbeat().catch(() => {});
    if (inFlight.size >= d.concurrency) {
      await Promise.race(inFlight);
      continue;
    }
    try {
      // The poll itself belongs to no trace (tracing/untraced.ts) — an empty receive every 20s would
      // otherwise be a trace of its own. Each message's handling gets its consumer span below.
      const result = await untraced(() => d.sqs.send(
        new ReceiveMessageCommand({
          QueueUrl: d.requestUrl,
          MaxNumberOfMessages: Math.min(d.concurrency - inFlight.size, 10), // SQS hard cap is 10
          WaitTimeSeconds: d.pollWaitSeconds,
          // longer than any tool may run, so a slow read is never redelivered to a second
          // bridge replica while the first is still running it
          VisibilityTimeout: d.visibilitySeconds,
          // The sender's trace context rides as message attributes (never the body) — see tracing/sqs.ts.
          MessageAttributeNames: ["traceparent", "tracestate"],
        }),
        { abortSignal: signal }
      ));
      for (const msg of result.Messages ?? []) {
        const task: Promise<void> = withSqsConsumerSpan("bridge request", msg.MessageAttributes, () =>
          d.handle(msg.Body, msg.ReceiptHandle!)
        )
          .catch((err: unknown) => {
            logWithContext("error", `Bridge: handler failed — ${err instanceof Error ? err.message : String(err)}`, {});
          })
          .finally(() => inFlight.delete(task));
        inFlight.add(task);
      }
    } catch (err) {
      if (signal.aborted) break;
      logWithContext("error", `Bridge: poll error — retrying in 5s: ${err instanceof Error ? err.message : String(err)}`, {});
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  if (inFlight.size > 0) {
    logWithContext("info", `Bridge: draining ${inFlight.size} in-flight request(s)`, {});
    await Promise.allSettled(inFlight);
  }
}

async function resolveQueueUrl(sqs: SQSClient, name: string): Promise<string> {
  try {
    return (await sqs.send(new GetQueueUrlCommand({ QueueName: name }))).QueueUrl!;
  } catch (err) {
    if (!(err instanceof QueueDoesNotExist)) throw err;
    logWithContext("warn", `Bridge: queue "${name}" not found — creating`, {});
    const res = await sqs.send(
      new CreateQueueCommand({ QueueName: name, Attributes: { FifoQueue: "true", ContentBasedDeduplication: "false" } })
    );
    return res.QueueUrl!;
  }
}

/** TRANSPORT=sqs. Resolves when the loop stops (abort, then drain). */
export async function startSqsBridge(signal: AbortSignal): Promise<void> {
  const c = config.sqs;
  if (!c.requestQueueName) throw new Error("TRANSPORT=sqs needs MCP_SQS_REQUEST_QUEUE");
  const sqs = new SQSClient({
    region: c.region,
    // requestTimeout must exceed the long-poll wait so normal empty receives aren't cut short
    requestHandler: { connectionTimeout: 5000, requestTimeout: (c.pollWaitSeconds + 15) * 1000 },
    maxAttempts: 3,
  });
  const [requestUrl, responseUrl] = await Promise.all([resolveQueueUrl(sqs, c.requestQueueName), resolveQueueUrl(sqs, c.responseQueueName)]);
  const writeToolNames = new Set(writeTools.map((t) => t.name));
  logWithContext("info", "MCP Server started in SQS bridge mode", {
    transport: "sqs",
    requestQueue: c.requestQueueName,
    responseQueue: c.responseQueueName,
    tools: allTools.length,
    writeTools: allTools.filter((t) => writeToolNames.has(t.name)).length,
  });
  await pollRequests(signal, {
    sqs,
    requestUrl,
    concurrency: c.concurrency,
    pollWaitSeconds: c.pollWaitSeconds,
    visibilitySeconds: Math.ceil(TOOL_HANDLER_TIMEOUT_MS / 1000) + 30,
    heartbeat: () => writeFile(c.heartbeatFile, String(Date.now())),
    handle: (body, receiptHandle) =>
      handleBridgeMessage(body, {
        tools: allTools,
        writeToolNames,
        invoke: invokeTool,
        now: Date.now,
        reply: async (requestId, out) => {
          await sqs.send(new SendMessageCommand({ QueueUrl: responseUrl, MessageBody: out, MessageGroupId: requestId, MessageDeduplicationId: requestId }));
        },
        remove: async () => {
          await sqs.send(new DeleteMessageCommand({ QueueUrl: requestUrl, ReceiptHandle: receiptHandle }));
        },
      }),
  });
  sqs.destroy();
}

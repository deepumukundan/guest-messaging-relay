import {
  createExecutionContext,
  createMessageBatch,
  getQueueResult,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker, { type DeliveryJob } from "../src/index";

interface Pending {
  id: string;
  body: DeliveryJob;
  attempts: number;
  env: Env;
}

const pending: Pending[] = [];
let nextId = 0;

/**
 * Returns a copy of `base` whose DELIVERY queue records jobs in memory.
 * `drainQueue()` then runs the Worker's queue handler over them.
 * With `failSend`, every send throws, as a queue outage would.
 */
export function withQueue(
  base: Omit<Env, "DELIVERY"> & Partial<Pick<Env, "DELIVERY">>,
  options: { failSend?: boolean } = {},
): Env {
  const target = { ...base } as Env;
  const record = (body: unknown) => {
    if (options.failSend) {
      throw new Error("queue unavailable");
    }
    nextId += 1;
    pending.push({ id: `queued-${nextId}`, body: body as DeliveryJob, attempts: 1, env: target });
  };
  target.DELIVERY = {
    send: async (body: unknown) => record(body),
    sendBatch: async (messages: Iterable<MessageSendRequest>) => {
      for (const message of messages) {
        record(message.body);
      }
    },
  } as unknown as Queue;
  return target;
}

/** Jobs waiting in the stand-in queue. */
export function queuedJobs(): DeliveryJob[] {
  return pending.map((entry) => entry.body);
}

export function resetQueue(): void {
  pending.length = 0;
}

/**
 * Runs the queue handler once over every waiting job. A job the handler
 * retries goes back on the queue with attempts + 1. The test runtime does not
 * report retry delays, so retryDelaySeconds() is tested on its own.
 */
export async function drainQueue(): Promise<{ acked: number; retried: number }> {
  const current = pending.splice(0);
  const byEnv = new Map<Env, Pending[]>();
  for (const entry of current) {
    const group = byEnv.get(entry.env) ?? [];
    group.push(entry);
    byEnv.set(entry.env, group);
  }
  let acked = 0;
  let retried = 0;
  for (const [env, group] of byEnv) {
    const batch = createMessageBatch<DeliveryJob>(
      "guest-messaging-relay-delivery",
      group.map((entry) => ({ id: entry.id, timestamp: new Date(), attempts: entry.attempts, body: entry.body })),
    );
    const ctx = createExecutionContext();
    await worker.queue(batch, env, ctx);
    const result = await getQueueResult(batch, ctx);
    acked += result.explicitAcks.length;
    for (const retry of result.retryMessages) {
      const entry = group.find((candidate) => candidate.id === retry.msgId);
      if (entry) {
        pending.push({ ...entry, attempts: entry.attempts + 1 });
        retried += 1;
      }
    }
  }
  return { acked, retried };
}

/** Waits for the request's background work, then delivers what it queued. */
export async function settle(ctx: ExecutionContext): Promise<void> {
  await waitOnExecutionContext(ctx);
  await drainQueue();
}

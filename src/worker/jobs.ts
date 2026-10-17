import type { Outbox, Prisma } from "@prisma/client";
import { PersistentMockProvider, ProviderUnknown } from "../adapters/mock";
import type { MockScenario } from "../adapters/provider";
import { db, requireMockMode, serializable } from "../server/db";
import { enqueue, type Snapshot } from "../server/orders";
import { jsonValue, token } from "../server/security";

const provider = new PersistentMockProvider();

export async function claim(): Promise<Outbox | null> {
  requireMockMode();
  const leaseToken = token();
  const rows = await db.$queryRaw<Outbox[]>`
    WITH candidate AS (
      SELECT id FROM "Outbox"
      WHERE (state = 'PENDING' AND "availableAt" <= NOW())
         OR (state = 'RUNNING' AND "leaseUntil" < NOW())
      ORDER BY "availableAt" ASC
      FOR UPDATE SKIP LOCKED LIMIT 1
    )
    UPDATE "Outbox" AS job SET state = 'RUNNING', "leaseToken" = ${leaseToken},
      "leaseUntil" = NOW() + INTERVAL '60 seconds', attempts = attempts + 1
    FROM candidate WHERE job.id = candidate.id RETURNING job.*`;
  return rows[0] ?? null;
}

async function finish(job: Outbox, apply: (tx: Prisma.TransactionClient) => Promise<void>) {
  await serializable(async tx => {
    const held = await tx.outbox.updateMany({ where: { id: job.id, leaseToken: job.leaseToken, state: "RUNNING" },
      data: { state: "DONE", leaseToken: null, leaseUntil: null } });
    if (held.count) await apply(tx);
  });
}

export async function processJob(job: Outbox): Promise<void> {
  requireMockMode();
  const payload = jsonValue<{ scenario?: MockScenario; attemptId?: string }>(job.payload);
  const scenario = payload.scenario ?? "SUCCESS";
  if (job.kind === "PAYMENT") {
    const attempt = await db.paymentAttempt.findUniqueOrThrow({ where: { key: `charge:${job.aggregateId}` } });
    if (attempt.state === "SUCCEEDED" || attempt.state === "DECLINED") {
      await finish(job, async () => {}); return;
    }
    let result = await provider.lookup(attempt.key);
    if (!result && attempt.state === "UNKNOWN") throw new ProviderUnknown();
    if (!result) {
      try {
        result = await provider.charge({ orderId: attempt.orderId, key: attempt.key, amount: attempt.amount, scenario });
      } catch (error) {
        if (error instanceof ProviderUnknown) {
          await serializable(async tx => {
            const held = await tx.outbox.findFirst({ where: { id: job.id, leaseToken: job.leaseToken, state: "RUNNING" } });
            if (!held) return;
            const changed = await tx.paymentAttempt.updateMany({ where: { id: attempt.id, state: "PENDING" }, data: { state: "UNKNOWN" } });
            if (changed.count) await tx.order.update({ where: { id: attempt.orderId }, data: { paymentState: "UNKNOWN" } });
          });
        }
        throw error;
      }
    }
    const confirmed = result;
    await finish(job, async tx => {
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { state: confirmed.state, providerId: confirmed.providerId } });
      await tx.order.update({ where: { id: attempt.orderId }, data: { paymentState: confirmed.state === "SUCCEEDED" ? "PAID" : "DECLINED" } });
      if (confirmed.state === "SUCCEEDED") {
        await enqueue(tx, "SUBMIT_ORDER", attempt.orderId, `submit:${attempt.orderId}`);
        await enqueue(tx, "NOTIFY", attempt.orderId, `notify:${attempt.orderId}`);
      }
    });
  } else if (job.kind === "SUBMIT_ORDER") {
    const order = await db.order.findUniqueOrThrow({ where: { id: job.aggregateId } });
    const snapshot = jsonValue<Snapshot>(order.snapshot);
    await provider.submit({ orderId: order.id, pricing: snapshot.pricing, currency: snapshot.currency });
    await finish(job, async tx => {
      await tx.order.update({ where: { id: job.aggregateId }, data: { integrationState: "SYNCED" } });
      // Web queue is the intake channel. Staff acceptance is always a separate action.
    });
  } else if (job.kind === "PRINT") {
    await provider.requestPrint(job.aggregateId, job.dedupeKey, scenario);
    await finish(job, async tx => {
      await tx.order.update({ where: { id: job.aggregateId }, data: { printState: "ACCEPTED" } });
    });
  } else if (job.kind === "REFUND") {
    const attempt = await db.paymentAttempt.findUniqueOrThrow({ where: { id: payload.attemptId } });
    const result = await provider.lookup(attempt.key) ?? await provider.refund({ orderId: attempt.orderId, key: attempt.key, amount: attempt.amount });
    await finish(job, async tx => {
      const changed = await tx.paymentAttempt.updateMany({ where: { id: attempt.id, state: { not: "SUCCEEDED" } },
        data: { state: "SUCCEEDED", providerId: result.providerId } });
      if (changed.count) {
        const order = await tx.order.update({ where: { id: attempt.orderId }, data: { refundedAmount: { increment: attempt.amount } } });
        const snapshot = jsonValue<{ pricing: { total: number } }>(order.snapshot);
        if (order.refundedAmount === snapshot.pricing.total) {
          await tx.order.update({ where: { id: order.id }, data: { paymentState: "REFUNDED" } });
        }
      }
    });
  } else if (job.kind === "NOTIFY") {
    await provider.notify(job.aggregateId, job.id);
    await finish(job, async () => {});
  } else {
    throw new Error("UNKNOWN_JOB");
  }
}

export async function runOnce(): Promise<boolean> {
  const job = await claim();
  if (!job) return false;
  try { await processJob(job); } catch (error) {
    const dead = job.attempts >= 8;
    const delay = Math.min(300000, 1000 * 2 ** job.attempts) + Math.floor(Math.random() * 1000);
    await db.outbox.updateMany({ where: { id: job.id, leaseToken: job.leaseToken, state: "RUNNING" },
      data: { state: dead ? "DEAD" : "PENDING", leaseToken: null, leaseUntil: null,
        availableAt: new Date(Date.now() + delay), lastError: error instanceof ProviderUnknown ? "PROVIDER_UNKNOWN" : "PROVIDER_UNAVAILABLE" } });
    if (dead) await db.audit.create({ data: { actor: "worker", action: "OUTBOX_DEAD_LETTER", aggregateId: job.aggregateId } });
  }
  return true;
}

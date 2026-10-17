import type { Outbox, Prisma } from "@prisma/client";
import { PersistentMockProvider, ProviderUnavailable, ProviderUnknown } from "../adapters/mock";
import type { MockScenario } from "../adapters/provider";
import { db, requireMockMode, serializable } from "../server/db";
import { enqueue, type Snapshot } from "../server/orders";
import { jsonValue, token } from "../server/security";
import { transitionIntegration, transitionPayment, type IntegrationState, type PaymentState } from "../domain";

const provider = new PersistentMockProvider();

async function markPaymentUnknown(tx: Prisma.TransactionClient, orderId: string) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  if (!["PROCESSING", "UNKNOWN_REQUIRES_RECONCILIATION"].includes(order.paymentState)) return;
  const paymentState = transitionPayment(order.paymentState as PaymentState, "UNKNOWN_REQUIRES_RECONCILIATION");
  await tx.order.update({ where: { id: orderId }, data: { paymentState } });
}

async function updateIntegration(tx: Prisma.TransactionClient, orderId: string, next: IntegrationState) {
  const order = await tx.order.findUniqueOrThrow({ where: { id: orderId } });
  const integrationState = transitionIntegration(order.integrationState as IntegrationState, next);
  await tx.order.update({ where: { id: orderId }, data: { integrationState } });
}

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
  if (job.kind === "PAYMENT" || job.kind === "RECONCILE_PAYMENT") {
    const attempt = await db.paymentAttempt.findUniqueOrThrow({ where: { key: `charge:${job.aggregateId}` } });
    if (attempt.state === "SUCCEEDED" || attempt.state === "DECLINED") {
      await finish(job, async () => {}); return;
    }
    let result = await provider.lookup(attempt.key);
    if (!result && ["UNKNOWN", "DISPATCHED"].includes(attempt.state)) {
      await serializable(async tx => {
        if (!await tx.outbox.findFirst({ where: { id: job.id, leaseToken: job.leaseToken, state: "RUNNING" } })) return;
        await tx.paymentAttempt.updateMany({ where: { id: attempt.id, state: { in: ["UNKNOWN", "DISPATCHED"] } }, data: { state: "UNKNOWN" } });
        await markPaymentUnknown(tx, attempt.orderId);
      });
      throw new ProviderUnknown();
    }
    if (!result) {
      const providerOrder = await provider.lookupOrder(attempt.orderId);
      if (!providerOrder) throw new ProviderUnavailable();
      const dispatched = await serializable(async tx => {
        if (!await tx.outbox.findFirst({ where: { id: job.id, leaseToken: job.leaseToken, state: "RUNNING" } })) return false;
        const changed = await tx.paymentAttempt.updateMany({ where: { id: attempt.id, state: "PENDING" }, data: { state: "DISPATCHED" } });
        return changed.count > 0;
      });
      if (!dispatched) return;
      try {
        result = await provider.charge({ orderId: attempt.orderId, providerOrderId: providerOrder.providerId,
          key: attempt.key, amount: attempt.amount, scenario });
      } catch (error) {
        const definitiveUnavailable = error instanceof ProviderUnavailable;
        await serializable(async tx => {
          const held = await tx.outbox.findFirst({ where: { id: job.id, leaseToken: job.leaseToken, state: "RUNNING" } });
          if (!held) return;
          const changed = await tx.paymentAttempt.updateMany({ where: { id: attempt.id, state: "DISPATCHED" },
            data: { state: definitiveUnavailable ? "PENDING" : "UNKNOWN" } });
          if (changed.count && !definitiveUnavailable) await markPaymentUnknown(tx, attempt.orderId);
        });
        throw definitiveUnavailable ? error : new ProviderUnknown();
      }
    }
    const confirmed = result;
    await finish(job, async tx => {
      await tx.paymentAttempt.update({ where: { id: attempt.id }, data: { state: confirmed.state, providerId: confirmed.providerId } });
      const order = await tx.order.findUniqueOrThrow({ where: { id: attempt.orderId } });
      const paymentState = transitionPayment(order.paymentState as PaymentState, confirmed.state === "SUCCEEDED" ? "PAID" : "FAILED");
      await tx.order.update({ where: { id: attempt.orderId }, data: { paymentState } });
      if (confirmed.state === "SUCCEEDED") {
        await enqueue(tx, "NOTIFY", attempt.orderId, `notify:${attempt.orderId}`);
      }
    });
  } else if (job.kind === "SUBMIT_ORDER") {
    const order = await db.order.findUniqueOrThrow({ where: { id: job.aggregateId } });
    const snapshot = jsonValue<Snapshot>(order.snapshot);
    const held = await serializable(async tx => {
      if (!await tx.outbox.findFirst({ where: { id: job.id, leaseToken: job.leaseToken, state: "RUNNING" } })) return false;
      const current = await tx.order.findUniqueOrThrow({ where: { id: order.id } });
      if (current.integrationState !== "SYNCED") await updateIntegration(tx, order.id, "CREATING");
      return true;
    });
    if (!held) return;
    const providerOrder = await provider.lookupOrder(order.id) ??
      await provider.submit({ orderId: order.id, pricing: snapshot.pricing, currency: snapshot.currency });
    await finish(job, async tx => {
      await updateIntegration(tx, job.aggregateId, "SYNCED");
      await tx.order.update({ where: { id: job.aggregateId }, data: { providerOrderId: providerOrder.providerId } });
      await enqueue(tx, "PAYMENT", order.id, `payment:${order.id}`, { scenario });
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
        const paymentState = transitionPayment(order.paymentState as PaymentState,
          order.refundedAmount === snapshot.pricing.total ? "REFUNDED" : "PARTIALLY_REFUNDED");
        await tx.order.update({ where: { id: order.id }, data: { paymentState } });
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
    const attempt = ["PAYMENT", "RECONCILE_PAYMENT"].includes(job.kind)
      ? await db.paymentAttempt.findUnique({ where: { key: `charge:${job.aggregateId}` } }) : null;
    const unknown = error instanceof ProviderUnknown || ["UNKNOWN", "DISPATCHED"].includes(attempt?.state ?? "");
    const dead = !unknown && job.attempts >= 8;
    const delay = Math.min(300000, 1000 * 2 ** job.attempts) + Math.floor(Math.random() * 1000);
    await serializable(async tx => {
      const released = await tx.outbox.updateMany({ where: { id: job.id, leaseToken: job.leaseToken, state: "RUNNING" },
        data: { state: dead ? "DEAD" : "PENDING", ...(unknown ? { kind: "RECONCILE_PAYMENT" } : {}),
          leaseToken: null, leaseUntil: null, availableAt: new Date(Date.now() + delay),
          lastError: unknown ? "RECONCILIATION_REQUIRED" : "PROVIDER_UNAVAILABLE" } });
      if (!released.count) return;
      if (unknown && attempt) {
        await tx.paymentAttempt.updateMany({ where: { id: attempt.id, state: { in: ["UNKNOWN", "DISPATCHED"] } }, data: { state: "UNKNOWN" } });
        await markPaymentUnknown(tx, attempt.orderId);
      }
      if (job.kind === "SUBMIT_ORDER") {
        const current = await tx.order.findUniqueOrThrow({ where: { id: job.aggregateId } });
        if (!["SYNCED", "NOT_CREATED"].includes(current.integrationState)) {
          await updateIntegration(tx, job.aggregateId, dead ? "ACTION_REQUIRED" : "RETRY_PENDING");
        }
      }
      if (unknown && [1, 8].includes(job.attempts)) await tx.audit.create({
        data: { actor: "worker", action: "PAYMENT_RECONCILIATION_REQUIRED", aggregateId: job.aggregateId },
      });
      if (dead) await tx.audit.create({ data: { actor: "worker", action: "OUTBOX_DEAD_LETTER", aggregateId: job.aggregateId } });
    });
  }
  return true;
}

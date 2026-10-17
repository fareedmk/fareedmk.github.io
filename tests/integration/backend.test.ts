import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { NextRequest } from "next/server";
import { db, requireMockMode } from "../../src/server/db";
import { checkout, createQuote, type Snapshot } from "../../src/server/orders";
import { hash, jsonValue, token } from "../../src/server/security";
import { capacity, checkoutRoute, health, quotes, refund, reprint, retryJob, status, tracking } from "../../src/server/handlers";
import { PersistentMockProvider } from "../../src/adapters/mock";
import { claim, processJob, runOnce } from "../../src/worker/jobs";
import { deletePromotion, getPromotion, promotions, savePromotion, updatePromotion } from "../../src/server/promotions";

const suite = process.env.DATABASE_URL ? describe : describe.skip;
suite("PostgreSQL mock ordering", () => {
  const originalLocation = process.env.LOCATION_ID;
  const originalMode = process.env.CLOVER_MODE;
  const originalOrigin = process.env.APP_ORIGIN;
  const id = `test-${randomUUID()}`;
  const owner = hash(token());
  const productId = `${id}-product`;
  const slotId = `${id}-slot`;
  const context = (params: Record<string, string> = {}) => ({ params: Promise.resolve(params) });
  const createdOrders: string[] = [];
  let sessionToken: string;
  const request = (path: string, payload: unknown, origin = "http://localhost:3000", method = "POST") => new NextRequest(`http://localhost:3000${path}`, {
    method, headers: { origin, cookie: `ordering_admin=${sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const quote = (overrides: Record<string, unknown> = {}) => createQuote({
    lines: [{ productId, quantity: 1, modifiers: [] }], tip: 20, slotId,
    customer: { name: "Test Customer", email: "test@example.invalid", phone: "+441234567890", marketingConsent: false },
    ...overrides,
  }, owner);
  async function order(scenario: "SUCCESS" | "TIMEOUT_AFTER_SUCCESS" | "DECLINE" | "OUTAGE" = "SUCCESS") {
    const q = await quote();
    const trackingToken = token();
    const input = { quoteId: q.id, idempotencyKey: randomUUID(), mockScenario: scenario };
    const result = await checkout(input, owner, trackingToken);
    createdOrders.push(result.orderId);
    return { ...result, input };
  }
  async function drain() {
    for (let i = 0; i < 30 && await runOnce(); i++) { /* finite queue */ }
  }
  beforeAll(async () => {
    process.env.LOCATION_ID = id;
    process.env.CLOVER_MODE = "mock";
    process.env.APP_ORIGIN = "http://localhost:3000";
    await db.location.create({ data: { id, name: "Integration test", timeZone: "America/Chicago" } });
    await db.category.create({ data: { id: `${id}-category`, locationId: id, name: "Test" } });
    await db.taxRate.create({ data: { id: `${id}-tax`, name: "Test sales tax", bps: 1000 } });
    await db.product.create({ data: { id: productId, locationId: id, categoryId: `${id}-category`, taxId: `${id}-tax`,
      cloverId: `mock-${productId}`, name: "Test coffee", description: "Test", price: 300 } });
    await db.slot.create({ data: { id: slotId, locationId: id, startsAt: new Date(Date.now() + 3600000), capacity: 100 } });
    sessionToken = token();
    await db.session.create({ data: { id: hash(sessionToken), role: "owner", expiresAt: new Date(Date.now() + 3600000) } });
  });
  afterAll(async () => {
    const orders = await db.order.findMany({ where: { locationId: id }, select: { id: true } });
    const orderIds = orders.map(order => order.id);
    await db.paymentAttempt.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.mockProviderRecord.deleteMany({ where: { orderId: { in: orderIds } } });
    await db.outbox.deleteMany({ where: { aggregateId: { in: orderIds } } });
    await db.audit.deleteMany({ where: { aggregateId: { in: [id, ...orderIds] } } });
    const inbox = await db.inbox.findMany({ where: { source: "LOCAL_NOTIFICATION" } });
    await db.inbox.deleteMany({ where: { id: { in: inbox.filter(row => orderIds.includes(jsonValue<{ orderId: string }>(row.payload).orderId)).map(row => row.id) } } });
    await db.order.deleteMany({ where: { locationId: id } });
    await db.quote.deleteMany({ where: { locationId: id } });
    await db.slot.deleteMany({ where: { locationId: id } });
    await db.promotion.deleteMany({ where: { locationId: id } });
    await db.modifier.deleteMany({ where: { group: { product: { locationId: id } } } });
    await db.modifierGroup.deleteMany({ where: { product: { locationId: id } } });
    await db.product.deleteMany({ where: { locationId: id } });
    await db.category.deleteMany({ where: { locationId: id } });
    await db.taxRate.deleteMany({ where: { id: `${id}-tax` } });
    await db.location.deleteMany({ where: { id } });
    await db.session.deleteMany({ where: { id: hash(sessionToken) } });
    if (originalLocation === undefined) delete process.env.LOCATION_ID; else process.env.LOCATION_ID = originalLocation;
    if (originalMode === undefined) delete process.env.CLOVER_MODE; else process.env.CLOVER_MODE = originalMode;
    if (originalOrigin === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = originalOrigin;
    await db.$disconnect();
  });
  it("persists immutable authoritative prices and snapshots", async () => {
    const q = await quote();
    expect(q.pricing.total).toBe(350);
    await db.product.update({ where: { id: productId }, data: { price: 400, version: { increment: 1 } } });
    const saved = await db.quote.findUniqueOrThrow({ where: { id: q.id } });
    expect(jsonValue<Snapshot>(saved.snapshot).pricing.total).toBe(350);
    await expect(db.quote.update({ where: { id: q.id }, data: { snapshot: {} } })).rejects.toThrow();
    await db.product.update({ where: { id: productId }, data: { price: 300 } });
  });
  it("reserves the final capacity exactly once under concurrent quotes", async () => {
    const limited = await db.slot.create({ data: { id: `${id}-last`, locationId: id, startsAt: new Date(Date.now() + 7200000), capacity: 1 } });
    const results = await Promise.allSettled([quote({ slotId: limited.id }), quote({ slotId: limited.id })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected")).toHaveLength(1);
    expect((await capacity(request("/capacity", { slotId: limited.id, capacity: 0 }), context())).status).toBe(409);
  });
  it("reserves promotion use atomically and expires unused reservations", async () => {
    await db.promotion.create({ data: { locationId: id, code: "ONLYONE", percentBps: 1000, limit: 1 } });
    const results = await Promise.allSettled([quote({ code: "ONLYONE" }), quote({ code: "ONLYONE" })]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const success = results.find(result => result.status === "fulfilled");
    if (success?.status !== "fulfilled") throw new Error("Expected quote");
    await db.quote.update({ where: { id: success.value.id }, data: { expiresAt: new Date(0) } });
    expect((await quote({ code: "ONLYONE" })).pricing.discount).toBe(30);
  });
  it("rejects price, tax, and version changes before creating any payment", async () => {
    const original = await db.product.findUniqueOrThrow({ where: { id: productId } });
    for (const change of [{ price: original.price + 1 }, { version: original.version + 1 }]) {
      const q = await quote();
      await db.product.update({ where: { id: productId }, data: change });
      await expect(checkout({ quoteId: q.id, idempotencyKey: randomUUID(), mockScenario: "SUCCESS" }, owner, token())).rejects.toMatchObject({ code: "PRICE_CHANGED" });
      expect(await db.order.count({ where: { quoteId: q.id } })).toBe(0);
      await db.product.update({ where: { id: productId }, data: { price: original.price, version: original.version } });
    }
    const q = await quote();
    await db.taxRate.update({ where: { id: `${id}-tax` }, data: { bps: 1100 } });
    await expect(checkout({ quoteId: q.id, idempotencyKey: randomUUID(), mockScenario: "SUCCESS" }, owner, token())).rejects.toMatchObject({ code: "PRICE_CHANGED" });
    await db.taxRate.update({ where: { id: `${id}-tax` }, data: { bps: 1000 } });
  });
  it("rejects product and modifier availability, constraints, and price changes", async () => {
    const q = await quote();
    await db.product.update({ where: { id: productId }, data: { available: false } });
    await expect(checkout({ quoteId: q.id, idempotencyKey: randomUUID(), mockScenario: "SUCCESS" }, owner, token())).rejects.toMatchObject({ code: "AVAILABILITY_CHANGED" });
    await db.product.update({ where: { id: productId }, data: { available: true } });
    const groupId = `${id}-group`;
    const modifierId = `${id}-modifier`;
    await db.modifierGroup.create({ data: { id: groupId, productId, name: "Extras", min: 0, max: 1 } });
    await db.modifier.create({ data: { id: modifierId, groupId, cloverId: `mock-${modifierId}`, name: "Extra shot", price: 50 } });
    const withModifier = await quote({ lines: [{ productId, quantity: 1, modifiers: [{ modifierId, quantity: 1 }] }] });
    const input = { quoteId: withModifier.id, idempotencyKey: randomUUID(), mockScenario: "SUCCESS" as const };
    await db.modifier.update({ where: { id: modifierId }, data: { available: false } });
    await expect(checkout(input, owner, token())).rejects.toMatchObject({ code: "AVAILABILITY_CHANGED" });
    await db.modifier.update({ where: { id: modifierId }, data: { available: true, price: 70 } });
    await expect(checkout(input, owner, token())).rejects.toMatchObject({ code: "PRICE_CHANGED" });
    await db.modifier.update({ where: { id: modifierId }, data: { price: 50 } });
    await db.modifierGroup.update({ where: { id: groupId }, data: { max: 0 } });
    await expect(checkout(input, owner, token())).rejects.toMatchObject({ code: "AVAILABILITY_CHANGED" });
    await db.modifier.delete({ where: { id: modifierId } });
    await db.modifierGroup.delete({ where: { id: groupId } });
  });
  it("revalidates promotion activation, terms, and reservation limits at checkout", async () => {
    const promo = await db.promotion.create({ data: { locationId: id, code: "CHECKOUT10", percentBps: 1000, limit: 10 } });
    const q = await quote({ code: promo.code });
    const input = { quoteId: q.id, idempotencyKey: randomUUID(), mockScenario: "SUCCESS" as const };
    await db.promotion.update({ where: { id: promo.id }, data: { active: false } });
    await expect(checkout(input, owner, token())).rejects.toMatchObject({ code: "AVAILABILITY_CHANGED" });
    await db.promotion.update({ where: { id: promo.id }, data: { active: true, percentBps: 2000 } });
    await expect(checkout(input, owner, token())).rejects.toMatchObject({ code: "PRICE_CHANGED" });
    await db.promotion.update({ where: { id: promo.id }, data: { percentBps: 1000, limit: 0 } });
    await expect(checkout(input, owner, token())).rejects.toMatchObject({ code: "AVAILABILITY_CHANGED" });
  });
  it("revalidates pickup slot capacity and time at checkout", async () => {
    const slot = await db.slot.findUniqueOrThrow({ where: { id: slotId } });
    const q = await quote();
    const input = { quoteId: q.id, idempotencyKey: randomUUID(), mockScenario: "SUCCESS" as const };
    await db.slot.update({ where: { id: slotId }, data: { capacity: 0 } });
    await expect(checkout(input, owner, token())).rejects.toMatchObject({ code: "AVAILABILITY_CHANGED" });
    await db.slot.update({ where: { id: slotId }, data: { capacity: slot.capacity, startsAt: new Date(slot.startsAt.getTime() + 60000) } });
    await expect(checkout(input, owner, token())).rejects.toMatchObject({ code: "AVAILABILITY_CHANGED" });
    await db.slot.update({ where: { id: slotId }, data: { startsAt: slot.startsAt } });
  });
  it("creates and associates the original provider order before charging", async () => {
    const initial = await order();
    expect(initial.status).toBe("PROCESSING");
    expect(await db.mockProviderRecord.count({ where: { orderId: initial.orderId } })).toBe(0);
    await expect(new PersistentMockProvider().charge({ orderId: initial.orderId, providerOrderId: "missing",
      key: `charge:${initial.orderId}`, amount: 350, scenario: "SUCCESS" })).rejects.toThrow("PROVIDER_ORDER_REQUIRED");
    await db.outbox.update({ where: { dedupeKey: `submit:${initial.orderId}` }, data: { availableAt: new Date(1) } });
    const submission = await claim();
    expect(submission?.kind).toBe("SUBMIT_ORDER");
    expect(submission?.aggregateId).toBe(initial.orderId);
    await processJob(submission!);
    const saved = await db.order.findUniqueOrThrow({ where: { id: initial.orderId } });
    const providerOrder = await db.mockProviderRecord.findUniqueOrThrow({ where: { key: `order:${initial.orderId}` } });
    expect(saved.providerOrderId).toBe(providerOrder.providerId);
    expect(await db.mockProviderRecord.count({ where: { orderId: initial.orderId, operation: "CHARGE" } })).toBe(0);
    await drain();
    const payment = await db.mockProviderRecord.findUniqueOrThrow({ where: { key: `charge:${initial.orderId}` } });
    expect(jsonValue<{ providerOrderId: string }>(payment.payload).providerOrderId).toBe(providerOrder.providerId);
    expect(payment.createdAt.getTime()).toBeGreaterThanOrEqual(providerOrder.createdAt.getTime());
  });
  it("reconciles the original provider order after a crash before local association", async () => {
    const initial = await order();
    const saved = await db.order.findUniqueOrThrow({ where: { id: initial.orderId } });
    const snapshot = jsonValue<Snapshot>(saved.snapshot);
    const original = await new PersistentMockProvider().submit({ orderId: saved.id, pricing: snapshot.pricing, currency: snapshot.currency });
    expect(saved.providerOrderId).toBeNull();
    await drain();
    expect((await db.order.findUniqueOrThrow({ where: { id: saved.id } })).providerOrderId).toBe(original.providerId);
    expect(await db.mockProviderRecord.count({ where: { orderId: saved.id, operation: "ORDER" } })).toBe(1);
    const payment = await db.mockProviderRecord.findUniqueOrThrow({ where: { key: `charge:${saved.id}` } });
    expect(jsonValue<{ providerOrderId: string }>(payment.payload).providerOrderId).toBe(original.providerId);
  });
  it("has payload-matching idempotency and owner isolation", async () => {
    const initial = await order();
    const replay = await checkout(initial.input, owner, initial.trackingToken);
    expect(replay.orderId).toBe(initial.orderId);
    await expect(checkout({ ...initial.input, mockScenario: "DECLINE" }, owner, initial.trackingToken)).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(checkout(initial.input, hash("other-owner"), initial.trackingToken)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await drain();
  });
  it("binds the public quote/checkout API to HttpOnly ownership cookies", async () => {
    const response = await quotes(request("/api/quotes", {
      lines: [{ productId, quantity: 1, modifiers: [] }], tip: 0, slotId,
      customer: { name: "API Customer", email: "api@example.invalid", phone: "+441234567890", marketingConsent: false },
    }), context());
    expect(response.status).toBe(201);
    const result = await response.json();
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    const payload = { quoteId: result.id, idempotencyKey: randomUUID(), mockScenario: "SUCCESS" };
    const missingCookies = await checkoutRoute(request("/api/checkout", payload), context());
    expect(missingCookies.status).toBe(404);
    const cookie = `ordering_owner=${response.cookies.get("ordering_owner")?.value}; quote_${result.id}=${response.cookies.get(`quote_${result.id}`)?.value}`;
    const paid = await checkoutRoute(new NextRequest("http://localhost:3000/api/checkout", {
      method: "POST", headers: { origin: "http://localhost:3000", cookie, "content-type": "application/json" }, body: JSON.stringify(payload),
    }), context());
    expect(paid.status).toBe(202);
    expect((await paid.json()).trackingToken).toBe(result.token);
    await drain();
  });
  it("handles concurrent checkout replay without duplicate orders or payments", async () => {
    const q = await quote();
    const trackingToken = token();
    const input = { quoteId: q.id, idempotencyKey: randomUUID(), mockScenario: "SUCCESS" as const };
    const results = await Promise.all([checkout(input, owner, trackingToken), checkout(input, owner, trackingToken)]);
    expect(results[0].orderId).toBe(results[1].orderId);
    createdOrders.push(results[0].orderId);
    await drain();
    expect(await db.mockProviderRecord.count({ where: { orderId: results[0].orderId, operation: "CHARGE" } })).toBe(1);
  });
  it("reconciles timeout-after-success against the original payment, without recharge", async () => {
    const initial = await order("TIMEOUT_AFTER_SUCCESS");
    await drain();
    expect((await db.order.findUniqueOrThrow({ where: { id: initial.orderId } })).paymentState).toBe("UNKNOWN_REQUIRES_RECONCILIATION");
    await db.outbox.update({ where: { dedupeKey: `payment:${initial.orderId}` }, data: { availableAt: new Date(0) } });
    await drain();
    const saved = await db.order.findUniqueOrThrow({ where: { id: initial.orderId } });
    expect(saved.paymentState).toBe("PAID");
    expect(saved.fulfillmentState).toBe("SUBMITTED");
    expect(saved.integrationState).toBe("SYNCED");
    expect(await db.mockProviderRecord.count({ where: { orderId: initial.orderId, operation: "CHARGE" } })).toBe(1);
    const providerOrder = await db.mockProviderRecord.findUniqueOrThrow({ where: { key: `order:${initial.orderId}` } });
    expect(jsonValue<{ pricing: { lines: { cloverId: string }[] } }>(providerOrder.payload).pricing.lines[0].cloverId).toBe(`mock-${productId}`);
  });
  it("never recharges an unknown payment when lookup is inconclusive", async () => {
    const initial = await order();
    await db.paymentAttempt.update({ where: { key: `charge:${initial.orderId}` }, data: { state: "UNKNOWN" } });
    await db.order.update({ where: { id: initial.orderId }, data: { paymentState: "UNKNOWN_REQUIRES_RECONCILIATION" } });
    await drain();
    expect(await db.mockProviderRecord.count({ where: { orderId: initial.orderId, operation: "CHARGE" } })).toBe(0);
    expect((await db.order.findUniqueOrThrow({ where: { id: initial.orderId } })).paymentState).toBe("UNKNOWN_REQUIRES_RECONCILIATION");
    const job = await db.outbox.update({ where: { dedupeKey: `payment:${initial.orderId}` }, data: { attempts: 8, availableAt: new Date(0) } });
    await drain();
    const pending = await db.outbox.findUniqueOrThrow({ where: { id: job.id } });
    expect(pending.state).toBe("PENDING");
    expect(pending.kind).toBe("RECONCILE_PAYMENT");
    expect(await db.mockProviderRecord.count({ where: { orderId: initial.orderId, operation: "CHARGE" } })).toBe(0);
    expect(await db.audit.count({ where: { aggregateId: initial.orderId, action: "PAYMENT_RECONCILIATION_REQUIRED" } })).toBeGreaterThan(0);
  });
  it("treats a crash after payment dispatch as unknown and never starts another charge", async () => {
    const initial = await order();
    await db.paymentAttempt.update({ where: { key: `charge:${initial.orderId}` }, data: { state: "DISPATCHED" } });
    await drain();
    expect((await db.order.findUniqueOrThrow({ where: { id: initial.orderId } })).paymentState).toBe("UNKNOWN_REQUIRES_RECONCILIATION");
    expect(await db.mockProviderRecord.count({ where: { orderId: initial.orderId, operation: "CHARGE" } })).toBe(0);
  });
  it("declines payment against the original provider order without fulfillment acceptance", async () => {
    const initial = await order("DECLINE");
    await drain();
    expect((await db.order.findUniqueOrThrow({ where: { id: initial.orderId } })).paymentState).toBe("FAILED");
    expect(await db.mockProviderRecord.count({ where: { orderId: initial.orderId, operation: "ORDER" } })).toBe(1);
  });
  it("backs off unavailable payment jobs and preserves the reservation", async () => {
    const initial = await order("OUTAGE");
    await drain();
    const job = await db.outbox.findUniqueOrThrow({ where: { dedupeKey: `payment:${initial.orderId}` } });
    expect(job.state).toBe("PENDING");
    expect(job.availableAt.getTime()).toBeGreaterThan(Date.now());
    expect(await db.mockProviderRecord.count({ where: { orderId: initial.orderId, operation: "CHARGE" } })).toBe(0);
  });
  it("dead-letters bounded retries and permits an audited staff retry", async () => {
    const initial = await order("OUTAGE");
    await drain();
    const job = await db.outbox.update({ where: { dedupeKey: `payment:${initial.orderId}` }, data: { attempts: 7, availableAt: new Date(0) } });
    await drain();
    expect((await db.outbox.findUniqueOrThrow({ where: { id: job.id } })).state).toBe("DEAD");
    const retried = await retryJob(request("/retry", { confirm: true }), context({ id: job.id }));
    expect(retried.status).toBe(202);
    expect((await db.outbox.findUniqueOrThrow({ where: { id: job.id } })).attempts).toBe(0);
    await drain();
  });
  it("claims jobs with distinct leases and fences stale workers", async () => {
    const initial = await order();
    await db.outbox.update({ where: { dedupeKey: `submit:${initial.orderId}` }, data: { availableAt: new Date(1) } });
    const first = await claim();
    expect(first?.aggregateId).toBe(initial.orderId);
    await db.outbox.update({ where: { id: first!.id }, data: { leaseUntil: new Date(0) } });
    const recovered = await claim();
    expect(recovered?.id).toBe(first?.id);
    expect(recovered?.leaseToken).not.toBe(first?.leaseToken);
    await processJob(first!);
    expect((await db.order.findUniqueOrThrow({ where: { id: initial.orderId } })).paymentState).toBe("PROCESSING");
    await processJob(recovered!);
    await drain();
    expect((await db.order.findUniqueOrThrow({ where: { id: initial.orderId } })).paymentState).toBe("PAID");
  });
  it("only staff explicitly accepts an order, with CSRF enforcement", async () => {
    const initial = await order();
    await drain();
    const forbidden = await status(request("/api/admin/orders/x/status", { status: "ACCEPTED" }, "https://evil.invalid"), context({ id: initial.orderId }));
    expect(forbidden.status).toBe(403);
    const error = await forbidden.json();
    expect(error.error.message).toEqual(expect.any(String));
    expect(forbidden.headers.get("x-correlation-id")).toBe(error.error.correlationId);
    const accepted = await status(request("/api/admin/orders/x/status", { status: "ACCEPTED" }), context({ id: initial.orderId }));
    expect(accepted.status).toBe(200);
    expect((await accepted.json()).fulfillmentState).toBe("ACCEPTED");
    for (const state of ["PREPARING", "READY", "COMPLETED"]) {
      const advanced = await status(request("/status", { status: state }), context({ id: initial.orderId }));
      expect(advanced.status).toBe(200);
      expect((await advanced.json()).fulfillmentState).toBe(state);
    }
  });
  it("reports print request acceptance, not physical print evidence", async () => {
    const initial = await order();
    await drain();
    const response = await reprint(request("/api/admin/orders/x/reprint", { confirm: true, idempotencyKey: randomUUID() }), context({ id: initial.orderId }));
    expect(response.status).toBe(202);
    expect((await response.json()).physicalPrintConfirmed).toBe(false);
    await drain();
    expect((await db.order.findUniqueOrThrow({ where: { id: initial.orderId } })).printState).toBe("ACCEPTED");
  });
  it("reserves refunds against over-refund and replays the original operation", async () => {
    const initial = await order();
    await drain();
    const payload = { confirm: true, amount: 300, idempotencyKey: randomUUID() };
    expect((await refund(request("/refund", payload), context({ id: initial.orderId }))).status).toBe(202);
    expect((await refund(request("/refund", payload), context({ id: initial.orderId }))).status).toBe(202);
    const excess = await refund(request("/refund", { ...payload, amount: 100, idempotencyKey: randomUUID() }), context({ id: initial.orderId }));
    expect(excess.status).toBe(409);
    await drain();
    expect((await db.order.findUniqueOrThrow({ where: { id: initial.orderId } })).refundedAmount).toBe(300);
    expect((await db.order.findUniqueOrThrow({ where: { id: initial.orderId } })).paymentState).toBe("PARTIALLY_REFUNDED");
    expect(await db.mockProviderRecord.count({ where: { orderId: initial.orderId, operation: "REFUND" } })).toBe(1);
    const second = await refund(request("/refund", { ...payload, amount: 25, idempotencyKey: randomUUID() }), context({ id: initial.orderId }));
    expect(second.status).toBe(202);
    await drain();
    const partlyRefundedAgain = await db.order.findUniqueOrThrow({ where: { id: initial.orderId } });
    expect(partlyRefundedAgain.refundedAmount).toBe(325);
    expect(partlyRefundedAgain.paymentState).toBe("PARTIALLY_REFUNDED");
    const third = await refund(request("/refund", { ...payload, amount: 25, idempotencyKey: randomUUID() }), context({ id: initial.orderId }));
    expect(third.status).toBe(202);
    await drain();
    const fullyRefunded = await db.order.findUniqueOrThrow({ where: { id: initial.orderId } });
    expect(fullyRefunded.refundedAmount).toBe(350);
    expect(fullyRefunded.paymentState).toBe("REFUNDED");
  });
  it("supports strictly validated PERCENT promotion create/update/delete", async () => {
    const created = await savePromotion(request("/api/admin/promotions", {
      code: "crud_test", percentBps: 1200, limit: 10, active: true,
    }), context());
    expect(created.status).toBe(200);
    const { promotion } = await created.json();
    expect(promotion).toMatchObject({ code: "CRUD_TEST", percentBps: 1200, kind: "PERCENT" });
    const detailRequest = new NextRequest(`http://localhost:3000/api/admin/promotions/${promotion.id}`, {
      headers: { cookie: `ordering_admin=${sessionToken}` },
    });
    const detail = await getPromotion(detailRequest, context({ id: promotion.id }));
    expect(detail.status).toBe(200);
    expect((await detail.json()).promotion).toEqual(promotion);
    for (const invalid of [
      { code: "BAD_TEST", percentBps: 1250, limit: 10, active: true },
      { code: "BAD_TEST", percentBps: 1000, limit: 10, active: true, amount: 100 },
      { code: "BAD_TEST", percentBps: 1000, limit: 10, active: true, kind: "FIXED" },
      { code: "BAD_TEST", percentBps: 1000, percent: 10, limit: 10, active: true },
    ]) expect((await savePromotion(request("/api/admin/promotions", invalid), context())).status).toBe(400);
    const patched = await updatePromotion(request("/api/admin/promotions/x", {
      percentBps: 1500, active: false,
    }, undefined, "PATCH"), context({ id: promotion.id }));
    expect(patched.status).toBe(200);
    expect((await patched.json()).promotion).toMatchObject({ percentBps: 1500, active: false });
    const deleted = await deletePromotion(request("/api/admin/promotions/x", { confirm: true }, undefined, "DELETE"), context({ id: promotion.id }));
    expect(deleted.status).toBe(200);
    expect(await db.promotion.findUnique({ where: { id: promotion.id } })).toBeNull();
    expect((await getPromotion(detailRequest, context({ id: promotion.id }))).status).toBe(404);
  });
  it("paginates promotion administration and preserves referenced promotion history", async () => {
    const url = "http://localhost:3000/api/admin/promotions";
    const get = (query: string) => new NextRequest(`${url}${query}`, { headers: { cookie: `ordering_admin=${sessionToken}` } });
    const first = await promotions(get("?limit=1"), context());
    const page = await first.json();
    expect(page.promotions).toHaveLength(1);
    expect(page.supportedKinds).toEqual(["PERCENT"]);
    expect(page.nextCursor).toEqual(expect.any(String));
    const second = await promotions(get(`?limit=1&cursor=${page.nextCursor}`), context());
    expect((await second.json()).promotions[0].id).not.toBe(page.promotions[0].id);
    expect((await promotions(get("?limit=101"), context())).status).toBe(400);
    expect((await promotions(get("?cursor=nonexistent"), context())).status).toBe(400);
    const referenced = await db.promotion.findUniqueOrThrow({ where: { locationId_code: { locationId: id, code: "ONLYONE" } } });
    const deletion = await deletePromotion(request("/api/admin/promotions/x", { confirm: true }, undefined, "DELETE"), context({ id: referenced.id }));
    expect(deletion.status).toBe(409);
    expect((await deletion.json()).error.code).toBe("PROMOTION_IN_USE");
    expect((await updatePromotion(request("/api/admin/promotions/x", { limit: 0 }, undefined, "PATCH"), context({ id: referenced.id }))).status).toBe(409);
    expect((await updatePromotion(request("/api/admin/promotions/x", { active: false }, undefined, "PATCH"), context({ id: referenced.id }))).status).toBe(200);
  });
  it("publishes safe tracking snapshots and supports revocation", async () => {
    const initial = await order();
    const response = await tracking(new NextRequest("http://localhost:3000/api/orders/token"), context({ token: initial.trackingToken }));
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.customer).toBeUndefined();
    expect(result.total).toBe(result.pricing.total);
    expect(result.pickupAt).toBe(result.slot.startsAt);
    expect(result.currency).toBe("USD");
    expect(result.timeZone).toBe("America/Chicago");
    expect(JSON.stringify(result)).not.toContain("test@example.invalid");
    await db.order.update({ where: { id: initial.orderId }, data: { trackingRevoked: true } });
    expect((await tracking(new NextRequest("http://localhost:3000/api/orders/token"), context({ token: initial.trackingToken }))).status).toBe(404);
    await drain();
  });
  it("fails closed for sandbox and production, including provider adapters", async () => {
    for (const mode of ["sandbox", "production", "typo"]) {
      process.env.CLOVER_MODE = mode;
      expect(() => requireMockMode()).toThrow("LIVE_INTEGRATION_BLOCKED");
      expect((await health(new NextRequest("http://localhost:3000/api/health"), context())).status).toBe(503);
      await expect(new PersistentMockProvider().lookup("anything")).rejects.toThrow("LIVE_INTEGRATION_BLOCKED");
    }
    process.env.CLOVER_MODE = "mock";
  });
});

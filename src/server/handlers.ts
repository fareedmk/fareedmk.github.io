import { NextResponse } from "next/server";
import { z } from "zod";
import { catalog } from "./catalog";
import { db, locationId, serializable } from "./db";
import { checkout, checkoutInput, createQuote, enqueue, listSlots, parse, publicOrder, quoteInput, reservationWhere, type Snapshot } from "./orders";
import { body, hash, HttpError, jsonValue, ownerHash, passwordHash, passwordMatches, rateLimit, requireAdmin, route, sameOrigin, token } from "./security";

const cookieOptions = { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "strict" as const, path: "/" };
export const menu = route(async () => {
  const location = await db.location.findUnique({ where: { id: locationId() }, select: { id: true, name: true, timeZone: true, paused: true } });
  if (!location) throw new HttpError(503, "NOT_CONFIGURED");
  const categories = await db.category.findMany({ where: { locationId: location.id }, select: { id: true, name: true }, orderBy: { id: "asc" } });
  return NextResponse.json({ mode: "mock", location, categories, products: await catalog() });
});
export const slots = route(async () => NextResponse.json({ slots: await listSlots() }));
export const quotes = route(async request => {
  sameOrigin(request);
  await rateLimit(request, "quotes", 20);
  const owner = request.cookies.get("ordering_owner")?.value ?? token();
  const result = await createQuote(parse(quoteInput, await body(request)), hash(owner));
  const trackingToken = token();
  const response = NextResponse.json({ ...result, token: trackingToken }, { status: 201 });
  response.cookies.set("ordering_owner", owner, { ...cookieOptions, maxAge: 86400 });
  response.cookies.set(`quote_${result.id}`, trackingToken, { ...cookieOptions, maxAge: 86400 });
  return response;
});
export const checkoutRoute = route(async request => {
  sameOrigin(request);
  await rateLimit(request, "checkout", 30);
  const input = parse(checkoutInput, await body(request));
  const trackingToken = request.cookies.get(`quote_${input.quoteId}`)?.value;
  if (!request.cookies.get("ordering_owner")?.value || !trackingToken) throw new HttpError(404, "NOT_FOUND");
  return NextResponse.json(await checkout(input, ownerHash(request), trackingToken), { status: 202 });
});
export const tracking = route(async (request, context) => {
  await rateLimit(request, "tracking", 120);
  const { token: trackingToken } = await context.params;
  if (!/^[A-Za-z0-9_-]{43}$/.test(trackingToken)) throw new HttpError(404, "NOT_FOUND");
  const order = await db.order.findFirst({ where: { locationId: locationId(), trackingHash: hash(trackingToken), trackingRevoked: false } });
  if (!order) throw new HttpError(404, "NOT_FOUND");
  return NextResponse.json(publicOrder(order));
});

export const login = route(async request => {
  sameOrigin(request);
  await rateLimit(request, "admin-login", 8);
  const { password } = parse(z.object({ password: z.string().min(1).max(256) }).strict(), await body(request));
  let credential = await db.adminCredential.findUnique({ where: { id: "owner" } });
  if (!credential) {
    const bootstrap = process.env.ADMIN_PASSWORD;
    if (!bootstrap || bootstrap.length < 12 || bootstrap.length > 256) throw new HttpError(503, "ADMIN_NOT_CONFIGURED");
    credential = await db.adminCredential.upsert({ where: { id: "owner" }, update: {},
      create: { id: "owner", passwordHash: passwordHash(bootstrap) } });
  }
  if (!passwordMatches(password, credential.passwordHash)) throw new HttpError(401, "UNAUTHORIZED");
  const sessionToken = token();
  const oldSession = request.cookies.get("ordering_admin")?.value;
  if (oldSession) await db.session.deleteMany({ where: { id: hash(oldSession) } });
  await db.session.create({ data: { id: hash(sessionToken), role: "owner", expiresAt: new Date(Date.now() + 8 * 3600000) } });
  await db.audit.create({ data: { actor: "owner", action: "ADMIN_LOGIN" } });
  const response = NextResponse.json({ role: "owner" });
  response.cookies.set("ordering_admin", sessionToken, { ...cookieOptions, maxAge: 8 * 3600 });
  return response;
});
export const logout = route(async request => {
  await requireAdmin(request);
  const value = request.cookies.get("ordering_admin")?.value;
  await db.session.deleteMany({ where: { id: hash(value!) } });
  const response = NextResponse.json({ ok: true });
  response.cookies.set("ordering_admin", "", { ...cookieOptions, maxAge: 0 });
  return response;
});
export const adminOrders = route(async request => {
  await requireAdmin(request);
  const orders = await db.order.findMany({ where: { locationId: locationId() }, orderBy: { createdAt: "desc" }, take: 100 });
  return NextResponse.json({ orders: orders.map(order => ({
    ...publicOrder(order), customer: jsonValue<Snapshot>(order.snapshot).customer,
    instructions: jsonValue<Snapshot>(order.snapshot).instructions,
  })) });
});

const transitions: Record<string, string[]> = {
  NEW: ["ACCEPTED", "REJECTED"], ACCEPTED: ["PREPARING"], PREPARING: ["READY"], READY: ["COLLECTED"],
};
export const status = route(async (request, context) => {
  await requireAdmin(request);
  const { id } = await context.params;
  const input = parse(z.object({ status: z.enum(["ACCEPTED", "REJECTED", "PREPARING", "READY", "COLLECTED"]) }).strict(), await body(request));
  const order = await serializable(async tx => {
    const current = await tx.order.findFirst({ where: { id, locationId: locationId() } });
    if (!current) throw new HttpError(404, "NOT_FOUND");
    if (current.fulfillmentState === input.status) return current;
    if (current.paymentState !== "PAID" || !transitions[current.fulfillmentState]?.includes(input.status)) throw new HttpError(409, "INVALID_TRANSITION");
    const updated = await tx.order.update({ where: { id }, data: { fulfillmentState: input.status } });
    await tx.audit.create({ data: { actor: "owner", action: `FULFILLMENT_${input.status}`, aggregateId: id } });
    return updated;
  });
  return NextResponse.json(publicOrder(order));
});

export const refund = route(async (request, context) => {
  await requireAdmin(request);
  await rateLimit(request, "refund", 20);
  const { id } = await context.params;
  const input = parse(z.object({ amount: z.number().int().positive().max(100000), confirm: z.literal(true),
    idempotencyKey: z.string().min(16).max(100) }).strict(), await body(request));
  const result = await serializable(async tx => {
    const order = await tx.order.findFirst({ where: { id, locationId: locationId() } });
    if (!order) throw new HttpError(404, "NOT_FOUND");
    const key = `refund:${locationId()}:${input.idempotencyKey}`;
    const payloadHash = hash(JSON.stringify({ orderId: id, amount: input.amount }));
    const previous = await tx.paymentAttempt.findUnique({ where: { key } });
    if (previous) {
      if (previous.payloadHash !== payloadHash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      return { id: previous.id, status: previous.state };
    }
    if (order.paymentState !== "PAID") throw new HttpError(409, "PAYMENT_NOT_REFUNDABLE");
    const reserved = await tx.paymentAttempt.aggregate({ where: { orderId: id, operation: "REFUND", state: { not: "DECLINED" } }, _sum: { amount: true } });
    if ((reserved._sum.amount ?? 0) + input.amount > jsonValue<Snapshot>(order.snapshot).pricing.total) throw new HttpError(409, "REFUND_EXCEEDS_PAYMENT");
    const attempt = await tx.paymentAttempt.create({ data: { orderId: id, operation: "REFUND", key, payloadHash, amount: input.amount } });
    await enqueue(tx, "REFUND", id, key, { attemptId: attempt.id });
    await tx.audit.create({ data: { actor: "owner", action: "REFUND_REQUESTED", aggregateId: id } });
    return { id: attempt.id, status: "PENDING" };
  });
  return NextResponse.json(result, { status: 202 });
});

export const reprint = route(async (request, context) => {
  await requireAdmin(request);
  await rateLimit(request, "reprint", 10);
  const { id } = await context.params;
  const input = parse(z.object({ confirm: z.literal(true), idempotencyKey: z.string().min(16).max(100),
    mockScenario: z.enum(["SUCCESS", "PRINT_UNAVAILABLE"]).default("SUCCESS") }).strict(), await body(request));
  await serializable(async tx => {
    const order = await tx.order.findFirst({ where: { id, locationId: locationId() } });
    if (!order) throw new HttpError(404, "NOT_FOUND");
    if (!["PAID", "REFUNDED"].includes(order.paymentState)) throw new HttpError(409, "PAYMENT_NOT_CONFIRMED");
    const key = `print:${id}:${input.idempotencyKey}`;
    const previous = await tx.outbox.findUnique({ where: { dedupeKey: key } });
    if (previous) {
      if (jsonValue<{ scenario: string }>(previous.payload).scenario !== input.mockScenario) throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      return;
    }
    await tx.order.update({ where: { id }, data: { printState: "REQUESTED" } });
    await enqueue(tx, "PRINT", id, key, { scenario: input.mockScenario });
    await tx.audit.create({ data: { actor: "owner", action: "PRINT_REQUESTED_NOT_PHYSICAL_CONFIRMATION", aggregateId: id } });
  });
  return NextResponse.json({ status: "REQUESTED", physicalPrintConfirmed: false }, { status: 202 });
});

export const revokeTracking = route(async (request, context) => {
  await requireAdmin(request);
  const { id } = await context.params;
  const changed = await db.order.updateMany({ where: { id, locationId: locationId() }, data: { trackingRevoked: true } });
  if (!changed.count) throw new HttpError(404, "NOT_FOUND");
  await db.audit.create({ data: { actor: "owner", action: "TRACKING_REVOKED", aggregateId: id } });
  return NextResponse.json({ ok: true });
});
export const pause = route(async request => {
  await requireAdmin(request);
  const input = parse(z.object({ paused: z.boolean() }).strict(), await body(request));
  await db.$transaction([
    db.location.update({ where: { id: locationId() }, data: input }),
    db.audit.create({ data: { actor: "owner", action: input.paused ? "ORDERING_PAUSED" : "ORDERING_RESUMED", aggregateId: locationId() } }),
  ]);
  return NextResponse.json(input);
});
export const adminSlots = route(async request => {
  await requireAdmin(request);
  const rows = await db.slot.findMany({ where: { locationId: locationId(), startsAt: { gt: new Date() } }, orderBy: { startsAt: "asc" }, take: 96 });
  return NextResponse.json({ slots: await Promise.all(rows.map(async slot => ({
    id: slot.id, startsAt: slot.startsAt, capacity: slot.capacity,
    reserved: await db.quote.count({ where: { slotId: slot.id, ...reservationWhere(new Date()) } }),
  }))) });
});
export const capacity = route(async request => {
  await requireAdmin(request);
  const input = parse(z.object({ slotId: z.string().min(1).max(120), capacity: z.number().int().min(0).max(200) }).strict(), await body(request));
  await serializable(async tx => {
    const slot = await tx.slot.findFirst({ where: { id: input.slotId, locationId: locationId() } });
    if (!slot) throw new HttpError(404, "NOT_FOUND");
    const reserved = await tx.quote.count({ where: { slotId: slot.id, ...reservationWhere(new Date()) } });
    if (input.capacity < reserved) throw new HttpError(409, "CAPACITY_BELOW_RESERVATIONS");
    await tx.slot.update({ where: { id: slot.id }, data: { capacity: input.capacity } });
    await tx.audit.create({ data: { actor: "owner", action: "SLOT_CAPACITY_CHANGED", aggregateId: locationId() } });
  });
  return NextResponse.json({ ok: true });
});
export const promotions = route(async request => {
  await requireAdmin(request);
  return NextResponse.json({ promotions: await db.promotion.findMany({ where: { locationId: locationId() }, orderBy: { code: "asc" }, take: 100 }) });
});
export const savePromotion = route(async request => {
  await requireAdmin(request);
  const input = parse(z.object({ code: z.string().trim().regex(/^[A-Z0-9_-]{3,32}$/),
    percent: z.number().int().min(1).max(100), limit: z.number().int().min(0).max(100000), active: z.boolean() }).strict(), await body(request));
  await serializable(async tx => {
    const previous = await tx.promotion.findUnique({ where: { locationId_code: { locationId: locationId(), code: input.code } } });
    const used = previous ? await tx.quote.count({ where: { promotionId: previous.id, ...reservationWhere(new Date()) } }) : 0;
    if (input.limit < used) throw new HttpError(409, "LIMIT_BELOW_RESERVATIONS");
    await tx.promotion.upsert({ where: { locationId_code: { locationId: locationId(), code: input.code } },
      update: { percentBps: input.percent * 100, limit: input.limit, active: input.active },
      create: { locationId: locationId(), code: input.code, percentBps: input.percent * 100, limit: input.limit, active: input.active } });
    await tx.audit.create({ data: { actor: "owner", action: "PROMOTION_UPDATED", aggregateId: locationId() } });
  });
  return NextResponse.json({ ok: true });
});
export const retryJob = route(async (request, context) => {
  await requireAdmin(request);
  parse(z.object({ confirm: z.literal(true) }).strict(), await body(request));
  const { id } = await context.params;
  await serializable(async tx => {
    const job = await tx.outbox.findUnique({ where: { id } });
    if (!job || !await tx.order.findFirst({ where: { id: job.aggregateId, locationId: locationId() } })) throw new HttpError(404, "NOT_FOUND");
    if (job.state !== "DEAD") throw new HttpError(409, "JOB_NOT_DEAD");
    await tx.outbox.update({ where: { id }, data: { state: "PENDING", attempts: 0, availableAt: new Date(), lastError: null } });
    await tx.audit.create({ data: { actor: "owner", action: "DEAD_LETTER_RETRY", aggregateId: job.aggregateId } });
  });
  return NextResponse.json({ status: "PENDING" }, { status: 202 });
});
export const integration = route(async request => {
  await requireAdmin(request);
  const orderIds = await db.order.findMany({ where: { locationId: locationId() }, select: { id: true } });
  const deadLetters = await db.outbox.findMany({ where: { state: "DEAD", aggregateId: { in: orderIds.map(order => order.id) } },
    select: { id: true, kind: true, aggregateId: true, attempts: true, lastError: true }, take: 100 });
  return NextResponse.json({ mode: "mock", liveIntegration: "BLOCKED", intake: "STAFF_WEB_QUEUE",
    printing: "REQUEST_ACCEPTANCE_ONLY", deadLetters,
    oauth: "UNSUPPORTED", webhooks: "UNSUPPORTED" });
});
export const sync = route(async request => {
  await requireAdmin(request);
  await db.audit.create({ data: { actor: "owner", action: "MOCK_CATALOG_READ", aggregateId: locationId() } });
  return NextResponse.json({ mode: "mock", products: (await catalog()).length, message: "Persistent mock catalog; no Clover network calls." });
});
export const health = route(async () => {
  await db.$queryRaw`SELECT 1`;
  return NextResponse.json({ status: "ok", mode: "mock" });
});
export const blocked = route(async () => { throw new HttpError(503, "INTEGRATION_UNSUPPORTED"); });

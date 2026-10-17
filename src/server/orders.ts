import { Prisma } from "@prisma/client";
import { z } from "zod";
import { priceCart, DomainError, type Pricing } from "../domain";
import { mockScenarios } from "../adapters/provider";
import { catalog } from "./catalog";
import { db, locationId, serializable } from "./db";
import { hash, HttpError, jsonValue } from "./security";

const text = z.string().trim().min(1).max(120);
export const quoteInput = z.object({
  lines: z.array(z.object({
    productId: text, quantity: z.number().int().min(1).max(20),
    modifiers: z.array(z.object({ modifierId: text, quantity: z.number().int().min(1).max(10) })).max(20),
    instructions: z.string().trim().max(300).optional(),
  })).min(1).max(30),
  tip: z.number().int().min(0).max(10000).default(0), code: text.optional(), slotId: text,
  customer: z.object({
    name: text, email: z.email().max(254), phone: z.string().regex(/^[+()\d .-]{7,30}$/),
    recipientName: text.optional(), recipientPhone: z.string().regex(/^[+()\d .-]{7,30}$/).optional(),
    marketingConsent: z.boolean().default(false),
  }),
  instructions: z.string().trim().max(500).optional(),
}).strict();
export const checkoutInput = z.object({
  quoteId: text, idempotencyKey: z.string().min(16).max(100),
  mockScenario: z.enum(mockScenarios).default("SUCCESS"),
}).strict();
export type Snapshot = {
  pricing: Pricing; customer: z.infer<typeof quoteInput>["customer"];
  instructions?: string; slot: { id: string; startsAt: string }; currency: "USD"; timeZone: string;
};

export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new HttpError(400, "INVALID_REQUEST");
  return parsed.data;
}

// A paid/pending order retains its reservation even after the originating quote expires.
export const reservationWhere = (now: Date): Prisma.QuoteWhereInput => ({
  OR: [
    { order: { is: null }, expiresAt: { gt: now } },
    { order: { is: { paymentState: { notIn: ["DECLINED", "CANCELLED"] } } } },
  ],
});

export async function createQuote(input: z.infer<typeof quoteInput>, ownerHash: string) {
  return serializable(async tx => {
    const now = new Date();
    const location = await tx.location.findUnique({ where: { id: locationId() } });
    if (!location || location.paused) throw new HttpError(409, "ORDERING_PAUSED");
    const slot = await tx.slot.findFirst({ where: { id: input.slotId, locationId: location.id, startsAt: { gt: now } } });
    if (!slot) throw new HttpError(409, "SLOT_UNAVAILABLE");
    const occupied = await tx.quote.count({ where: { slotId: slot.id, ...reservationWhere(now) } });
    if (occupied >= slot.capacity) throw new HttpError(409, "SLOT_FULL");
    const promo = input.code ? await tx.promotion.findUnique({
      where: { locationId_code: { locationId: location.id, code: input.code.toUpperCase() } },
    }) : null;
    if (input.code && (!promo || !promo.active)) throw new HttpError(409, "PROMOTION_UNAVAILABLE");
    if (promo && await tx.quote.count({ where: { promotionId: promo.id, ...reservationWhere(now) } }) >= promo.limit) {
      throw new HttpError(409, "PROMOTION_EXHAUSTED");
    }
    let pricing: Pricing;
    try {
      pricing = priceCart(await catalog(tx), input.lines, promo ? {
        id: promo.id, code: promo.code, kind: "PERCENT", value: promo.percentBps / 100,
        minSpend: 0, maxDiscount: 1000000,
      } : undefined, input.tip);
    } catch (error) {
      if (error instanceof DomainError) throw new HttpError(409, error.code);
      throw error;
    }
    if (pricing.total <= 0 || pricing.total > 100000) throw new HttpError(400, "INVALID_TOTAL");
    const snapshot: Snapshot = { pricing, customer: input.customer, instructions: input.instructions,
      slot: { id: slot.id, startsAt: slot.startsAt.toISOString() }, currency: "USD", timeZone: location.timeZone };
    const quote = await tx.quote.create({ data: { locationId: location.id, slotId: slot.id, ownerHash,
      promotionId: promo?.id, expiresAt: new Date(Math.min(now.getTime() + 10 * 60000, slot.startsAt.getTime())),
      snapshot: JSON.parse(JSON.stringify(snapshot)) } });
    return { id: quote.id, expiresAt: quote.expiresAt, pricing };
  });
}

export async function enqueue(tx: Prisma.TransactionClient, kind: string, aggregateId: string, dedupeKey: string, payload: Prisma.InputJsonValue = {}) {
  await tx.outbox.upsert({ where: { dedupeKey }, update: {}, create: { kind, aggregateId, dedupeKey, payload } });
}

export async function checkout(input: z.infer<typeof checkoutInput>, owner: string, trackingToken: string) {
  return serializable(async tx => {
    const requestHash = hash(JSON.stringify(input));
    const existing = await tx.order.findUnique({
      where: { locationId_idempotencyKey: { locationId: locationId(), idempotencyKey: input.idempotencyKey } },
      include: { quote: true },
    });
    if (existing) {
      if (existing.quote.ownerHash !== owner || existing.trackingHash !== hash(trackingToken)) throw new HttpError(404, "NOT_FOUND");
      if (existing.requestHash !== requestHash) throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
      return { trackingToken, status: existing.paymentState, orderId: existing.id };
    }
    const quote = await tx.quote.findFirst({ where: { id: input.quoteId, locationId: locationId(), ownerHash: owner }, include: { order: true, location: true } });
    if (!quote) throw new HttpError(404, "NOT_FOUND");
    if (quote.order) throw new HttpError(409, "QUOTE_ALREADY_USED");
    if (quote.expiresAt <= new Date()) throw new HttpError(409, "QUOTE_EXPIRED");
    if (quote.location.paused) throw new HttpError(409, "ORDERING_PAUSED");
    const order = await tx.order.create({ data: { locationId: quote.locationId, quoteId: quote.id,
      snapshot: jsonValue<Prisma.InputJsonValue>(quote.snapshot), trackingHash: hash(trackingToken),
      idempotencyKey: input.idempotencyKey, requestHash } });
    const snapshot = jsonValue<Snapshot>(quote.snapshot);
    await tx.paymentAttempt.create({ data: { orderId: order.id, operation: "CHARGE", key: `charge:${order.id}`,
      payloadHash: requestHash, amount: snapshot.pricing.total } });
    await enqueue(tx, "PAYMENT", order.id, `payment:${order.id}`, { scenario: input.mockScenario });
    await tx.audit.create({ data: { actor: "customer", action: "CHECKOUT_INITIATED", aggregateId: order.id } });
    return { trackingToken, status: order.paymentState, orderId: order.id };
  });
}

export function publicOrder(order: { id: string; snapshot: Prisma.JsonValue; paymentState: string; integrationState: string; fulfillmentState: string; printState: string; refundedAmount: number; createdAt: Date }) {
  const snapshot = jsonValue<Snapshot>(order.snapshot);
  return { id: order.id, items: snapshot.pricing.lines, pricing: snapshot.pricing, slot: snapshot.slot,
    currency: snapshot.currency, timeZone: snapshot.timeZone, paymentState: order.paymentState, integrationState: order.integrationState,
    fulfillmentState: order.fulfillmentState, printState: order.printState, refundedAmount: order.refundedAmount,
    createdAt: order.createdAt };
}

export async function listSlots() {
  const now = new Date();
  const slots = await db.slot.findMany({ where: { locationId: locationId(), startsAt: { gt: now } }, orderBy: { startsAt: "asc" }, take: 96 });
  return Promise.all(slots.map(async slot => ({ id: slot.id, startsAt: slot.startsAt,
    remaining: Math.max(0, slot.capacity - await db.quote.count({ where: { slotId: slot.id, ...reservationWhere(now) } })) })));
}

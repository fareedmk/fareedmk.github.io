import { NextResponse } from "next/server";
import { z } from "zod";
import { db, locationId, serializable } from "./db";
import { parse, reservationWhere } from "./orders";
import { body, HttpError, rateLimit, requireAdmin, route } from "./security";

const fields = {
  code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,32}$/),
  percentBps: z.number().int().min(100).max(10000).multipleOf(100),
  percent: z.number().int().min(1).max(100),
  limit: z.number().int().min(0).max(100000),
  active: z.boolean(),
};
const createInput = z.object({
  ...fields, percentBps: fields.percentBps.optional(), percent: fields.percent.optional(),
}).strict().refine(value => (value.percentBps === undefined) !== (value.percent === undefined));
const updateInput = z.object(fields).partial().strict()
  .refine(value => Object.keys(value).length > 0 && !(value.percent !== undefined && value.percentBps !== undefined));
const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().min(1).max(120).optional(),
});
const presentation = (promotion: { id: string; code: string; percentBps: number; limit: number; active: boolean }) => ({
  id: promotion.id, code: promotion.code, percentBps: promotion.percentBps,
  limit: promotion.limit, active: promotion.active, kind: "PERCENT" as const,
});

export const promotions = route(async request => {
  await requireAdmin(request);
  const { limit, cursor } = parse(pagination, {
    limit: request.nextUrl.searchParams.get("limit") ?? undefined,
    cursor: request.nextUrl.searchParams.get("cursor") ?? undefined,
  });
  if (cursor && !await db.promotion.findFirst({ where: { id: cursor, locationId: locationId() } })) throw new HttpError(400, "INVALID_CURSOR");
  const rows = await db.promotion.findMany({
    where: { locationId: locationId() }, orderBy: { id: "asc" }, take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
  });
  const page = rows.slice(0, limit);
  return NextResponse.json({
    promotions: page.map(presentation), nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    supportedKinds: ["PERCENT"],
  });
});

export const getPromotion = route(async (request, context) => {
  await requireAdmin(request);
  const { id } = await context.params;
  const promotion = await db.promotion.findFirst({ where: { id, locationId: locationId() } });
  if (!promotion) throw new HttpError(404, "NOT_FOUND");
  return NextResponse.json({ promotion: presentation(promotion) });
});

export const savePromotion = route(async request => {
  await requireAdmin(request);
  await rateLimit(request, "promotion-write", 30);
  const input = parse(createInput, await body(request));
  const promotion = await serializable(async tx => {
    const previous = await tx.promotion.findUnique({ where: { locationId_code: { locationId: locationId(), code: input.code } } });
    const used = previous ? await tx.quote.count({ where: { promotionId: previous.id, ...reservationWhere(new Date()) } }) : 0;
    if (input.limit < used) throw new HttpError(409, "LIMIT_BELOW_RESERVATIONS");
    const data = { percentBps: input.percentBps ?? input.percent! * 100, limit: input.limit, active: input.active };
    const saved = await tx.promotion.upsert({ where: { locationId_code: { locationId: locationId(), code: input.code } },
      update: data, create: { locationId: locationId(), code: input.code, ...data } });
    await tx.audit.create({ data: { actor: "owner", action: previous ? "PROMOTION_UPDATED" : "PROMOTION_CREATED", aggregateId: locationId() } });
    return saved;
  });
  return NextResponse.json({ ok: true, promotion: presentation(promotion) });
});

export const updatePromotion = route(async (request, context) => {
  await requireAdmin(request);
  await rateLimit(request, "promotion-write", 30);
  const { id } = await context.params;
  const input = parse(updateInput, await body(request));
  const promotion = await serializable(async tx => {
    const current = await tx.promotion.findFirst({ where: { id, locationId: locationId() } });
    if (!current) throw new HttpError(404, "NOT_FOUND");
    if (input.code && input.code !== current.code &&
      await tx.promotion.findUnique({ where: { locationId_code: { locationId: locationId(), code: input.code } } })) {
      throw new HttpError(409, "PROMOTION_CODE_IN_USE");
    }
    const used = await tx.quote.count({ where: { promotionId: id, ...reservationWhere(new Date()) } });
    if (input.limit !== undefined && input.limit < used) throw new HttpError(409, "LIMIT_BELOW_RESERVATIONS");
    const saved = await tx.promotion.update({ where: { id }, data: {
      ...(input.code !== undefined ? { code: input.code } : {}),
      ...(input.percentBps !== undefined || input.percent !== undefined ? { percentBps: input.percentBps ?? input.percent! * 100 } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
    } });
    await tx.audit.create({ data: { actor: "owner", action: "PROMOTION_UPDATED", aggregateId: locationId() } });
    return saved;
  });
  return NextResponse.json({ promotion: presentation(promotion) });
});

export const deletePromotion = route(async (request, context) => {
  await requireAdmin(request);
  await rateLimit(request, "promotion-write", 30);
  parse(z.object({ confirm: z.literal(true) }).strict(), await body(request));
  const { id } = await context.params;
  await serializable(async tx => {
    if (!await tx.promotion.findFirst({ where: { id, locationId: locationId() } })) throw new HttpError(404, "NOT_FOUND");
    // Referenced rules remain part of quote/order history. Disable them with PATCH.
    if (await tx.quote.count({ where: { promotionId: id } })) throw new HttpError(409, "PROMOTION_IN_USE");
    await tx.promotion.delete({ where: { id } });
    await tx.audit.create({ data: { actor: "owner", action: "PROMOTION_DELETED", aggregateId: locationId() } });
  });
  return NextResponse.json({ deleted: true });
});

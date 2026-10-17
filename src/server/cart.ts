import { NextResponse } from "next/server";
import { DomainError, priceCart } from "../domain";
import { catalog } from "./catalog";
import { db, locationId } from "./db";
import { parse, quoteInput, reservationWhere } from "./orders";
import { body, HttpError, rateLimit, route, sameOrigin } from "./security";

const cartInput = quoteInput.pick({ lines: true, tip: true, code: true }).strict();

export const productDetails = route(async (_request, context) => {
  const { id } = await context.params;
  const product = (await catalog()).find(product => product.id === id);
  if (!product) throw new HttpError(404, "NOT_FOUND");
  return NextResponse.json({ product, mode: "mock" });
});

export const validateCart = route(async request => {
  sameOrigin(request);
  await rateLimit(request, "cart-validation", 30);
  const input = parse(cartInput, await body(request));
  const promotion = input.code ? await db.promotion.findUnique({
    where: { locationId_code: { locationId: locationId(), code: input.code.toUpperCase() } },
  }) : null;
  if (input.code && (!promotion || !promotion.active)) throw new HttpError(409, "PROMOTION_UNAVAILABLE");
  if (promotion && await db.quote.count({
    where: { promotionId: promotion.id, ...reservationWhere(new Date()) },
  }) >= promotion.limit) throw new HttpError(409, "PROMOTION_EXHAUSTED");
  try {
    const pricing = priceCart(await catalog(), input.lines, promotion ? {
      id: promotion.id, code: promotion.code, kind: "PERCENT", value: promotion.percentBps / 100,
      minSpend: 0, maxDiscount: 1000000,
    } : undefined, input.tip, new Date());
    return NextResponse.json({
      pricing, reservation: false, payableQuote: false,
      promotion: promotion ? {
        code: promotion.code, source: "APP_MANAGED", eligible: true,
        explanation: "One non-stacking full-cart percentage code before tax. Capacity is not reserved until checkout quote.",
      } : null,
    });
  } catch (error) {
    if (error instanceof DomainError) throw new HttpError(409, error.code);
    throw error;
  }
});

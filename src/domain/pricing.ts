import { allocateMoney, integer, multiply, roundedRate, sum } from "./money";
import { CartLine, DomainError, PricedLine, Pricing, Product, Promotion } from "./types";

function fail(code: string, message: string): never {
  throw new DomainError(code, message);
}

function timestamp(value: string | number | Date): number {
  if (typeof value === "string" && !/(Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    fail("INVALID_DATE", "Promotion timestamps must include a UTC offset");
  }
  const result = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  if (!Number.isSafeInteger(result) || !Number.isFinite(new Date(result).getTime())) fail("INVALID_DATE", "Invalid promotion date");
  return result;
}

function snapshot(product: Product, line: CartLine, lineIndex: number): PricedLine {
  integer(line.quantity, "quantity", 1);
  if (!product.available) fail("UNAVAILABLE_PRODUCT", `Product ${product.id} is unavailable`);
  integer(product.price, "price");
  integer(product.taxBps, "taxBps");
  if (product.taxBps > 10000) fail("INVALID_TAX", "taxBps cannot exceed 10000");
  integer(product.version, "version");
  if (line.instructions !== undefined && typeof line.instructions !== "string") {
    fail("INVALID_INSTRUCTIONS", "Instructions must be text");
  }
  const known = new Map<string, Product["groups"][number]["modifiers"][number]>();
  const groupIds = new Set<string>();
  for (const group of product.groups) {
    if (groupIds.has(group.id)) fail("INVALID_CATALOG", "Duplicate modifier group");
    groupIds.add(group.id);
    integer(group.min, "group.min");
    integer(group.max, "group.max");
    if (group.min > group.max) fail("INVALID_CATALOG", "Modifier minimum exceeds maximum");
    for (const modifier of group.modifiers) {
      if (known.has(modifier.id)) fail("INVALID_CATALOG", "Duplicate catalog modifier");
      integer(modifier.price, "modifier.price");
      integer(modifier.maxQuantity, "modifier.maxQuantity");
      known.set(modifier.id, modifier);
    }
  }
  const selected = new Map<string, number>();
  const modifiers = line.modifiers.map((selection) => {
    if (selected.has(selection.modifierId)) fail("DUPLICATE_MODIFIER", "Modifier selected more than once");
    const modifier = known.get(selection.modifierId);
    if (!modifier) fail("UNKNOWN_MODIFIER", `Unknown modifier ${selection.modifierId}`);
    integer(selection.quantity, "modifier.quantity", 1);
    if (!modifier.available) fail("UNAVAILABLE_MODIFIER", `Modifier ${modifier.id} is unavailable`);
    if (selection.quantity > modifier.maxQuantity) fail("MODIFIER_QUANTITY", "Modifier quantity exceeds maximum");
    selected.set(modifier.id, selection.quantity);
    return Object.freeze({
      modifierId: modifier.id,
      cloverId: modifier.cloverId,
      name: modifier.name,
      quantity: selection.quantity,
      unitPrice: modifier.price,
      total: multiply(multiply(modifier.price, selection.quantity), line.quantity),
    });
  });
  for (const group of product.groups) {
    const count = sum(group.modifiers.map((modifier) => selected.get(modifier.id) ?? 0));
    if (count < group.min || count > group.max) {
      fail("MODIFIER_GROUP_CONSTRAINT", `Group ${group.id} requires ${group.min}–${group.max} selections per item`);
    }
  }
  const baseTotal = multiply(product.price, line.quantity);
  const modifierTotal = sum(modifiers.map((modifier) => modifier.total));
  const subtotal = sum([baseTotal, modifierTotal]);
  return {
    lineIndex, productId: product.id, cloverId: product.cloverId,
    categoryId: product.categoryId, name: product.name, version: product.version,
    quantity: line.quantity, unitPrice: product.price, taxBps: product.taxBps,
    ...(line.instructions === undefined ? {} : { instructions: line.instructions }),
    modifiers: Object.freeze(modifiers), baseTotal, modifierTotal, subtotal,
    discount: 0, tax: 0, total: subtotal,
  };
}

function promotionDiscount(lines: readonly PricedLine[], promotion: Promotion, now?: string | number | Date): number[] {
  integer(promotion.value, "promotion.value");
  integer(promotion.minSpend, "promotion.minSpend");
  integer(promotion.maxDiscount, "promotion.maxDiscount");
  if (!["PERCENT", "FIXED", "BOGO"].includes(promotion.kind)) fail("INVALID_PROMOTION", "Unknown promotion kind");
  if (promotion.kind === "PERCENT" && promotion.value > 100) fail("INVALID_PROMOTION", "Percentage exceeds 100");
  if (promotion.kind === "BOGO" && promotion.value !== 0) fail("INVALID_PROMOTION", "BOGO value must be zero");
  const startsAt = promotion.startsAt === undefined ? undefined : timestamp(promotion.startsAt);
  const endsAt = promotion.endsAt === undefined ? undefined : timestamp(promotion.endsAt);
  if (startsAt !== undefined && endsAt !== undefined && startsAt >= endsAt) fail("INVALID_PROMOTION", "Invalid promotion interval");
  const empty = lines.map(() => 0);
  if (startsAt !== undefined || endsAt !== undefined) {
    if (now === undefined) fail("PROMOTION_TIME_REQUIRED", "Dated promotions require an explicit evaluation time");
    const at = timestamp(now);
    if ((startsAt !== undefined && at < startsAt) || (endsAt !== undefined && at >= endsAt)) return empty;
  }
  if (sum(lines.map((line) => line.subtotal)) < promotion.minSpend) return empty;
  // When both restrictions exist, a line must satisfy both.
  const eligible = lines.map((line) =>
    (!promotion.productIds || promotion.productIds.includes(line.productId)) &&
    (!promotion.categoryIds || promotion.categoryIds.includes(line.categoryId)),
  );
  const weights = lines.map((line, index) => eligible[index] ? line.subtotal : 0);
  const qualifyingTotal = sum(weights);
  if (promotion.kind === "BOGO") {
    // Mix-and-match: the cheapest floor(eligible item count / 2) units are free.
    const units = sum(lines.map((line, index) => eligible[index] ? line.quantity : 0));
    let remaining = Math.floor(units / 2);
    const discounts = [...empty];
    const sorted = lines.filter((line) => eligible[line.lineIndex]).sort((a, b) =>
      a.subtotal / a.quantity - b.subtotal / b.quantity || a.lineIndex - b.lineIndex,
    );
    for (const line of sorted) {
      const free = Math.min(remaining, line.quantity);
      discounts[line.lineIndex] = multiply(line.subtotal / line.quantity, free);
      remaining -= free;
    }
    const raw = sum(discounts);
    return allocateMoney(Math.min(raw, promotion.maxDiscount), discounts);
  }
  const raw = promotion.kind === "PERCENT"
    ? roundedRate(qualifyingTotal, promotion.value, 100)
    : promotion.value;
  return allocateMoney(Math.min(raw, qualifyingTotal, promotion.maxDiscount), weights);
}

/**
 * Pure, immutable quote. Taxes round half-up per line after discount.
 * Tip is not taxed or discounted. No implicit wall clock or catalog mutation.
 */
export function priceCart(
  products: Product[], lines: CartLine[], promotion?: Promotion, tip = 0,
  now?: string | number | Date,
): Pricing {
  integer(tip, "tip");
  const catalog = new Map<string, Product>();
  for (const product of products) {
    if (catalog.has(product.id)) fail("INVALID_CATALOG", "Duplicate product id");
    catalog.set(product.id, product);
  }
  const snapshots = lines.map((line, index) => {
    const product = catalog.get(line.productId);
    if (!product) fail("UNKNOWN_PRODUCT", `Unknown product ${line.productId}`);
    return snapshot(product, line, index);
  });
  const discounts = promotion ? promotionDiscount(snapshots, promotion, now) : snapshots.map(() => 0);
  const priced = snapshots.map((line, index) => {
    const discount = discounts[index];
    const tax = roundedRate(line.subtotal - discount, line.taxBps, 10000);
    return Object.freeze({ ...line, discount, tax, total: sum([line.subtotal - discount, tax]) });
  });
  return Object.freeze({
    subtotal: sum(priced.map((line) => line.subtotal)),
    modifierTotal: sum(priced.map((line) => line.modifierTotal)),
    discount: sum(discounts),
    tax: sum(priced.map((line) => line.tax)),
    tip,
    total: sum([...priced.map((line) => line.total), tip]),
    lines: Object.freeze(priced),
  });
}

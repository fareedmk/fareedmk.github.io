import { describe, expect, it } from "vitest";
import {
  allocateMoney, allocateRefund, DomainError, pickupSlots, priceCart,
  transitionFulfillment, transitionIntegration, transitionPayment, transitionState,
  type FulfillmentState, type IntegrationState, type PaymentState, type Product, type Promotion,
} from "../../src/domain";

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "burger", cloverId: "clover-burger", name: "Burger", categoryId: "food",
    description: "A burger", price: 1000, taxBps: 1000, available: true, version: 1,
    groups: [{
      id: "extras", name: "Extras", min: 0, max: 2,
      modifiers: [{ id: "cheese", cloverId: "clover-cheese", name: "Cheese", price: 125, available: true, maxQuantity: 2 }],
    }],
    ...overrides,
  };
}

function promotion(overrides: Partial<Promotion> = {}): Promotion {
  return { id: "sale", code: "SALE", kind: "PERCENT", value: 10, minSpend: 0, maxDiscount: 100000, ...overrides };
}

describe("integer pricing and immutable snapshots", () => {
  it("prices base, modifier quantities, post-discount tax and untaxed tip", () => {
    const catalog = [product()];
    const quote = priceCart(catalog, [{
      productId: "burger", quantity: 2, modifiers: [{ modifierId: "cheese", quantity: 2 }],
      instructions: "No onions",
    }], promotion(), 200);
    expect(quote).toMatchObject({ subtotal: 2500, modifierTotal: 500, discount: 250, tax: 225, tip: 200, total: 2675 });
    expect(quote.lines[0]).toMatchObject({
      productId: "burger", cloverId: "clover-burger", name: "Burger", quantity: 2,
      baseTotal: 2000, modifierTotal: 500, discount: 250, tax: 225, total: 2475,
    });
    expect(quote.lines[0].modifiers[0]).toMatchObject({ name: "Cheese", quantity: 2, total: 500 });
    catalog[0].name = "Changed";
    catalog[0].groups[0].modifiers[0].name = "Changed";
    expect(quote.lines[0].name).toBe("Burger");
    expect(quote.lines[0].modifiers[0].name).toBe("Cheese");
    expect(Object.isFrozen(quote)).toBe(true);
    expect(Object.isFrozen(quote.lines)).toBe(true);
    expect(Object.isFrozen(quote.lines[0])).toBe(true);
    expect(Object.isFrozen(quote.lines[0].modifiers[0])).toBe(true);
  });

  it("uses exact largest remainders with stable ties", () => {
    expect(allocateMoney(2, [1, 1, 1])).toEqual([1, 1, 0]);
    expect(allocateMoney(1, [0, 2, 2])).toEqual([0, 1, 0]);
    expect(allocateMoney(Number.MAX_SAFE_INTEGER, [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]))
      .toEqual([4503599627370496, 4503599627370495]);
    expect(allocateMoney(0, [])).toEqual([]);
    expect(() => allocateMoney(1, [0])).toThrow(DomainError);
  });

  it("distributes a fixed discount and calculates tax after that allocation", () => {
    const quote = priceCart([product({ price: 101 })], [
      { productId: "burger", quantity: 1, modifiers: [] },
      { productId: "burger", quantity: 1, modifiers: [] },
      { productId: "burger", quantity: 1, modifiers: [] },
    ], promotion({ kind: "FIXED", value: 2 }));
    expect(quote.lines.map((line) => line.discount)).toEqual([1, 1, 0]);
    expect(quote).toMatchObject({ subtotal: 303, discount: 2, tax: 30, total: 331 });
  });

  it("rounds half-up using integer arithmetic", () => {
    const quote = priceCart([product({ price: 5, taxBps: 1000 })],
      [{ productId: "burger", quantity: 1, modifiers: [] }], promotion({ value: 10 }));
    expect(quote.discount).toBe(1);
    expect(quote.tax).toBe(0);
    expect(priceCart([product({ price: 5 })], [{ productId: "burger", quantity: 1, modifiers: [] }]).tax).toBe(1);
  });

  it.each([-1, 0.1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])("rejects invalid price %s", (price) => {
    expect(() => priceCart([product({ price })], [{ productId: "burger", quantity: 1, modifiers: [] }])).toThrow(DomainError);
  });

  it("rejects quantity, tip and overflow errors without losing precision", () => {
    const line = { productId: "burger", quantity: 1, modifiers: [] };
    expect(() => priceCart([product()], [{ ...line, quantity: 0 }])).toThrow(DomainError);
    expect(() => priceCart([product()], [{ ...line, quantity: 1.5 }])).toThrow(DomainError);
    expect(() => priceCart([product()], [line], undefined, -1)).toThrow(DomainError);
    expect(() => priceCart([product({ price: Number.MAX_SAFE_INTEGER })], [{ ...line, quantity: 2 }]))
      .toThrow(expect.objectContaining({ code: "MONEY_OVERFLOW" }));
    expect(() => priceCart([product({ price: Number.MAX_SAFE_INTEGER, taxBps: 0 })], [line], undefined, 1))
      .toThrow(expect.objectContaining({ code: "MONEY_OVERFLOW" }));
  });

  it("handles free items and an empty cart", () => {
    expect(priceCart([], [])).toMatchObject({ subtotal: 0, total: 0, lines: [] });
    expect(priceCart([product({ price: 0 })], [{ productId: "burger", quantity: 1, modifiers: [] }], promotion()).total).toBe(0);
  });
});

describe("promotion qualification", () => {
  const line = { productId: "burger", quantity: 1, modifiers: [] };
  it("enforces spend, cap, and product/category restrictions", () => {
    expect(priceCart([product()], [line], promotion({ minSpend: 1001 })).discount).toBe(0);
    expect(priceCart([product()], [line], promotion({ maxDiscount: 30 })).discount).toBe(30);
    expect(priceCart([product()], [line], promotion({ productIds: ["other"] })).discount).toBe(0);
    expect(priceCart([product()], [line], promotion({ categoryIds: ["other"] })).discount).toBe(0);
    expect(priceCart([product()], [line], promotion({ kind: "FIXED", value: 100000 })).discount).toBe(1000);
    expect(priceCart([product()], [line], promotion({ maxDiscount: 0 })).discount).toBe(0);
  });

  it("uses explicit time and an exclusive end", () => {
    const sale = promotion({ startsAt: "2026-01-01T00:00:00Z", endsAt: "2026-01-02T00:00:00Z" });
    expect(() => priceCart([product()], [line], sale)).toThrow(expect.objectContaining({ code: "PROMOTION_TIME_REQUIRED" }));
    expect(priceCart([product()], [line], sale, 0, sale.startsAt).discount).toBe(100);
    expect(priceCart([product()], [line], sale, 0, sale.endsAt).discount).toBe(0);
    expect(priceCart([product()], [line], sale, 0, "2025-12-31T23:59:59Z").discount).toBe(0);
    expect(() => priceCart([product()], [line], promotion({ value: 101 }))).toThrow(DomainError);
  });

  it("BOGO makes the cheapest eligible units free, with a cap", () => {
    const products = [product(), product({ id: "small", price: 300 })];
    const lines = [{ ...line, quantity: 3 }, { ...line, productId: "small", quantity: 2 }];
    const quote = priceCart(products, lines, promotion({ kind: "BOGO", value: 0 }));
    expect(quote.discount).toBe(600);
    expect(quote.lines.map((entry) => entry.discount)).toEqual([0, 600]);
    expect(priceCart(products, lines, promotion({ kind: "BOGO", value: 0, maxDiscount: 301 })).discount).toBe(301);
    expect(priceCart([product()], [{ ...line, quantity: 5 }], promotion({ kind: "BOGO", value: 0 })).discount).toBe(2000);
  });

  it("allocates only to eligible lines and preserves every discounted cent", () => {
    const products = [product({ price: 99 }), product({ id: "drink", categoryId: "drinks", price: 101 })];
    const quote = priceCart(products, [line, { ...line, productId: "drink" }],
      promotion({ kind: "FIXED", value: 100, categoryIds: ["food"] }));
    expect(quote.lines.map((entry) => entry.discount)).toEqual([99, 0]);
    expect(quote.lines.map((entry) => entry.tax)).toEqual([0, 10]);
    expect(quote.total).toBe(111);
  });
});

describe("modifier validation", () => {
  it.each([
    { modifiers: [{ modifierId: "unknown", quantity: 1 }], code: "UNKNOWN_MODIFIER" },
    { modifiers: [{ modifierId: "cheese", quantity: 1 }, { modifierId: "cheese", quantity: 1 }], code: "DUPLICATE_MODIFIER" },
    { modifiers: [{ modifierId: "cheese", quantity: 3 }], code: "MODIFIER_QUANTITY" },
    { modifiers: [{ modifierId: "cheese", quantity: 0 }], code: "INVALID_INTEGER" },
  ])("rejects $code", ({ modifiers, code }) => {
    expect(() => priceCart([product()], [{ productId: "burger", quantity: 1, modifiers }]))
      .toThrow(expect.objectContaining({ code }));
  });

  it("enforces group quantities per item, not per cart line", () => {
    const item = product();
    item.groups[0].min = 1;
    expect(() => priceCart([item], [{ productId: "burger", quantity: 2, modifiers: [] }]))
      .toThrow(expect.objectContaining({ code: "MODIFIER_GROUP_CONSTRAINT" }));
    expect(priceCart([item], [{ productId: "burger", quantity: 5, modifiers: [{ modifierId: "cheese", quantity: 1 }] }]).subtotal)
      .toBe(5625);
    item.groups[0].max = 1;
    expect(() => priceCart([item], [{ productId: "burger", quantity: 1, modifiers: [{ modifierId: "cheese", quantity: 2 }] }]))
      .toThrow(expect.objectContaining({ code: "MODIFIER_GROUP_CONSTRAINT" }));
  });

  it("rejects unavailable and ambiguous catalog entries", () => {
    const item = product();
    item.groups[0].modifiers[0].available = false;
    expect(() => priceCart([item], [{ productId: "burger", quantity: 1, modifiers: [{ modifierId: "cheese", quantity: 1 }] }]))
      .toThrow(expect.objectContaining({ code: "UNAVAILABLE_MODIFIER" }));
    expect(() => priceCart([product({ available: false })], [{ productId: "burger", quantity: 1, modifiers: [] }]))
      .toThrow(expect.objectContaining({ code: "UNAVAILABLE_PRODUCT" }));
    expect(() => priceCart([], [{ productId: "burger", quantity: 1, modifiers: [] }]))
      .toThrow(expect.objectContaining({ code: "UNKNOWN_PRODUCT" }));
    expect(() => priceCart([product(), product()], [])).toThrow(expect.objectContaining({ code: "INVALID_CATALOG" }));
    const ambiguous = product();
    ambiguous.groups[0].modifiers.push({ ...ambiguous.groups[0].modifiers[0] });
    expect(() => priceCart([ambiguous], [{ productId: "burger", quantity: 1, modifiers: [] }]))
      .toThrow(expect.objectContaining({ code: "INVALID_CATALOG" }));
  });
});

describe("independent state machines", () => {
  it("permits payment reconciliation but forbids unknown-payment retries", () => {
    expect(transitionPayment("UNPAID", "PROCESSING")).toBe("PROCESSING");
    expect(transitionPayment("PROCESSING", "UNKNOWN_REQUIRES_RECONCILIATION")).toBe("UNKNOWN_REQUIRES_RECONCILIATION");
    expect(transitionPayment("UNKNOWN_REQUIRES_RECONCILIATION", "PAID")).toBe("PAID");
    expect(transitionPayment("UNKNOWN_REQUIRES_RECONCILIATION", "FAILED")).toBe("FAILED");
    expect(() => transitionPayment("UNKNOWN_REQUIRES_RECONCILIATION", "PROCESSING")).toThrow(DomainError);
    expect(() => transitionPayment("PAID", "PROCESSING")).toThrow(DomainError);
    expect(transitionPayment("PAID", "PAID")).toBe("PAID");
    expect(transitionPayment("PAID", "PARTIALLY_REFUNDED")).toBe("PARTIALLY_REFUNDED");
    expect(transitionPayment("PARTIALLY_REFUNDED", "PARTIALLY_REFUNDED")).toBe("PARTIALLY_REFUNDED");
    expect(transitionPayment("PARTIALLY_REFUNDED", "REFUNDED")).toBe("REFUNDED");
  });

  it("keeps integration and fulfillment independent", () => {
    expect(transitionIntegration("NOT_CREATED", "CREATING")).toBe("CREATING");
    expect(transitionIntegration("CREATING", "RETRY_PENDING")).toBe("RETRY_PENDING");
    expect(transitionIntegration("RETRY_PENDING", "CREATING")).toBe("CREATING");
    expect(transitionIntegration("ACTION_REQUIRED", "SYNCED")).toBe("SYNCED");
    expect(() => transitionIntegration("SYNCED", "CREATING")).toThrow(DomainError);
    expect(transitionFulfillment("DRAFT", "SUBMITTED")).toBe("SUBMITTED");
    expect(transitionFulfillment("SUBMITTED", "ACCEPTED")).toBe("ACCEPTED");
    expect(transitionFulfillment("PREPARING", "READY")).toBe("READY");
    expect(() => transitionFulfillment("SUBMITTED", "COMPLETED")).toThrow(DomainError);
    expect(() => transitionFulfillment("CANCELLED", "ACCEPTED")).toThrow(DomainError);
  });

  it("accepts exactly the documented payment edges and idempotent self transitions", () => {
    const expected: Record<PaymentState, PaymentState[]> = {
      UNPAID: ["PROCESSING"], PROCESSING: ["PAID", "FAILED", "UNKNOWN_REQUIRES_RECONCILIATION"],
      PAID: ["PARTIALLY_REFUNDED", "REFUNDED"], FAILED: ["PROCESSING"],
      UNKNOWN_REQUIRES_RECONCILIATION: ["PAID", "FAILED"], PARTIALLY_REFUNDED: ["REFUNDED"], REFUNDED: [],
    };
    for (const from of Object.keys(expected) as PaymentState[]) {
      for (const to of Object.keys(expected) as PaymentState[]) {
        if (from === to || expected[from].includes(to)) expect(transitionPayment(from, to)).toBe(to);
        else expect(() => transitionPayment(from, to)).toThrow(expect.objectContaining({ code: "INVALID_TRANSITION" }));
      }
    }
  });

  it("accepts exactly the documented integration and fulfillment edges", () => {
    const expectedIntegration: Record<IntegrationState, IntegrationState[]> = {
      NOT_CREATED: ["CREATING"], CREATING: ["SYNCED", "RETRY_PENDING", "ACTION_REQUIRED"],
      RETRY_PENDING: ["CREATING", "ACTION_REQUIRED"], ACTION_REQUIRED: ["CREATING", "RETRY_PENDING", "SYNCED"],
      SYNCED: [],
    };
    for (const from of Object.keys(expectedIntegration) as IntegrationState[]) {
      for (const to of Object.keys(expectedIntegration) as IntegrationState[]) {
        if (from === to || expectedIntegration[from].includes(to)) expect(transitionIntegration(from, to)).toBe(to);
        else expect(() => transitionIntegration(from, to)).toThrow(DomainError);
      }
    }
    const expectedFulfillment: Record<FulfillmentState, FulfillmentState[]> = {
      DRAFT: ["SUBMITTED", "CANCELLED"], SUBMITTED: ["ACCEPTED", "CANCELLED"],
      ACCEPTED: ["PREPARING", "CANCELLED"], PREPARING: ["READY", "CANCELLED"],
      READY: ["COMPLETED", "CANCELLED"], COMPLETED: [], CANCELLED: [],
    };
    for (const from of Object.keys(expectedFulfillment) as FulfillmentState[]) {
      for (const to of Object.keys(expectedFulfillment) as FulfillmentState[]) {
        if (from === to || expectedFulfillment[from].includes(to)) expect(transitionFulfillment(from, to)).toBe(to);
        else expect(() => transitionFulfillment(from, to)).toThrow(DomainError);
      }
    }
  });

  it("rejects legacy and unknown states rather than keeping a parallel vocabulary", () => {
    for (const state of ["PENDING", "SUCCEEDED", "UNKNOWN", "__proto__"]) {
      expect(() => transitionPayment(state as PaymentState, "PROCESSING"))
        .toThrow(expect.objectContaining({ code: "INVALID_STATE" }));
    }
    expect(() => transitionState("invalid" as "payment", "UNPAID", "PROCESSING")).toThrow(DomainError);
  });
});

describe("refund allocation", () => {
  it("reconciles partial and repeated refunds without over-refunding", () => {
    const quote = priceCart([product({ price: 101, taxBps: 0 })], [
      { productId: "burger", quantity: 1, modifiers: [] },
      { productId: "burger", quantity: 1, modifiers: [] },
    ], undefined, 1);
    const first = allocateRefund(quote, 101);
    expect(first).toEqual({ amount: 101, lines: [{ lineIndex: 0, amount: 50 }, { lineIndex: 1, amount: 50 }], tip: 1 });
    const second = allocateRefund(quote, 102, [first]);
    expect(second).toEqual({ amount: 102, lines: [{ lineIndex: 0, amount: 51 }, { lineIndex: 1, amount: 51 }], tip: 0 });
    expect(() => allocateRefund(quote, 1, [first, second])).toThrow(DomainError);
    expect(allocateRefund(quote, 0, [first, second]).amount).toBe(0);
    expect(Object.isFrozen(first.lines)).toBe(true);
  });

  it("rejects invalid refund values and malformed prior refunds", () => {
    const quote = priceCart([product()], [{ productId: "burger", quantity: 1, modifiers: [] }]);
    expect(() => allocateRefund(quote, -1)).toThrow(DomainError);
    expect(() => allocateRefund(quote, quote.total + 1)).toThrow(DomainError);
    expect(() => allocateRefund(quote, 1, [{ amount: 2, lines: [], tip: 0 }])).toThrow(DomainError);
  });
});

describe("Chicago pickup scheduling", () => {
  const schedule = {
    now: "2026-06-01T14:00:00Z", timeZone: "America/Chicago", leadMinutes: 30,
    intervalMinutes: 30, capacity: 2, daysAhead: 1,
    hours: [{ day: 1, open: "09:00", close: "11:00" }],
  };

  it("honors lead time, capacity and exclusive closing time", () => {
    const slots = pickupSlots({
      ...schedule,
      reservations: [{ startsAt: "2026-06-01T14:30:00Z", quantity: 2 }, { startsAt: "2026-06-01T15:00:00Z", quantity: 1 }],
    });
    expect(slots.map((slot) => [slot.startsAt, slot.remainingCapacity])).toEqual([
      ["2026-06-01T15:00:00.000Z", 1], ["2026-06-01T15:30:00.000Z", 2],
    ]);
    expect(slots[0].endsAt).toBe("2026-06-01T15:30:00.000Z");
    expect(Object.isFrozen(slots)).toBe(true);
  });

  it("continues into future local dates and respects closures", () => {
    const slots = pickupSlots({
      ...schedule, now: "2026-06-01T23:00:00Z", daysAhead: 2,
      hours: [{ day: 2, open: "09:00", close: "10:00" }],
    });
    expect(slots.map((slot) => slot.startsAt)).toEqual(["2026-06-02T14:00:00.000Z", "2026-06-02T14:30:00.000Z"]);
    expect(pickupSlots({ ...schedule, closedDates: ["2026-06-01"] })).toEqual([]);
  });

  it("does not fabricate nonexistent spring-forward slots", () => {
    const slots = pickupSlots({
      ...schedule, now: "2026-03-08T06:00:00Z", leadMinutes: 0,
      hours: [{ day: 0, open: "01:00", close: "04:00" }],
    });
    expect(slots.map((slot) => slot.startsAt)).toEqual([
      "2026-03-08T07:00:00.000Z", "2026-03-08T07:30:00.000Z",
      "2026-03-08T08:00:00.000Z", "2026-03-08T08:30:00.000Z",
    ]);
  });

  it("represents both repeated fall-back hours by distinct UTC instants", () => {
    const slots = pickupSlots({
      ...schedule, now: "2026-11-01T05:00:00Z", leadMinutes: 0,
      hours: [{ day: 0, open: "01:00", close: "02:00" }],
    });
    expect(slots.map((slot) => slot.startsAt)).toEqual([
      "2026-11-01T06:00:00.000Z", "2026-11-01T06:30:00.000Z",
      "2026-11-01T07:00:00.000Z", "2026-11-01T07:30:00.000Z",
    ]);
  });

  it("handles overnight hours on the opening weekday", () => {
    const slots = pickupSlots({
      ...schedule, now: "2026-06-02T04:30:00Z", leadMinutes: 0, daysAhead: 2,
      hours: [{ day: 1, open: "23:00", close: "01:00" }],
    });
    expect(slots.map((slot) => slot.startsAt)).toEqual([
      "2026-06-02T04:30:00.000Z", "2026-06-02T05:00:00.000Z", "2026-06-02T05:30:00.000Z",
    ]);
  });

  it("rounds lead time upward and rejects invalid configuration", () => {
    expect(pickupSlots({ ...schedule, now: "2026-06-01T14:00:01Z" })[0].startsAt).toBe("2026-06-01T15:00:00.000Z");
    expect(() => pickupSlots({ ...schedule, intervalMinutes: 0 })).toThrow(DomainError);
    expect(() => pickupSlots({ ...schedule, timeZone: "not/a-zone" })).toThrow(DomainError);
    expect(() => pickupSlots({ ...schedule, now: "2026-06-01T09:00:00" })).toThrow(DomainError);
    expect(() => pickupSlots({ ...schedule, closedDates: ["2026-99-99"] })).toThrow(DomainError);
    expect(() => pickupSlots({ ...schedule, hours: [{ day: 1, open: "24:00", close: "25:00" }] })).toThrow(DomainError);
  });
});

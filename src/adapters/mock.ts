import { db, requireMockMode } from "../server/db";
import type { MockScenario, NotificationProvider, OrderProvider, PaymentProvider, PaymentResult } from "./provider";
import type { Pricing } from "../domain";
import { isDeepStrictEqual } from "node:util";

export class ProviderUnknown extends Error {}
export class ProviderUnavailable extends Error {}

export class PersistentMockProvider implements PaymentProvider, OrderProvider, NotificationProvider {
  async charge(input: { orderId: string; providerOrderId: string; key: string; amount: number; scenario: MockScenario }): Promise<PaymentResult> {
    requireMockMode();
    if (input.scenario === "OUTAGE") throw new ProviderUnavailable();
    const providerOrder = await db.mockProviderRecord.findUnique({ where: { key: `order:${input.orderId}` } });
    if (!providerOrder || providerOrder.providerId !== input.providerOrderId || providerOrder.operation !== "ORDER" ||
      providerOrder.amount !== input.amount) throw new Error("PROVIDER_ORDER_REQUIRED");
    const record = await db.mockProviderRecord.upsert({
      where: { key: input.key }, update: {},
      create: { key: input.key, orderId: input.orderId, operation: "CHARGE", amount: input.amount,
        state: input.scenario === "DECLINE" ? "DECLINED" : "SUCCEEDED", providerId: `mock_payment_${input.orderId}`,
        payload: { amount: input.amount, key: input.key, providerOrderId: input.providerOrderId } },
    });
    if (record.orderId !== input.orderId || record.amount !== input.amount || record.operation !== "CHARGE") throw new Error("PROVIDER_KEY_CONFLICT");
    if (input.scenario === "TIMEOUT_AFTER_SUCCESS") throw new ProviderUnknown();
    return { state: record.state as PaymentResult["state"], providerId: record.providerId };
  }
  async lookup(key: string): Promise<PaymentResult | null> {
    requireMockMode();
    const record = await db.mockProviderRecord.findUnique({ where: { key } });
    return record ? { state: record.state as PaymentResult["state"], providerId: record.providerId } : null;
  }
  async refund(input: { orderId: string; key: string; amount: number }): Promise<PaymentResult> {
    requireMockMode();
    const record = await db.mockProviderRecord.upsert({
      where: { key: input.key }, update: {},
      create: { ...input, operation: "REFUND", state: "SUCCEEDED", providerId: `mock_refund_${input.key}` },
    });
    if (record.orderId !== input.orderId || record.amount !== input.amount || record.operation !== "REFUND") throw new Error("PROVIDER_KEY_CONFLICT");
    return { state: "SUCCEEDED", providerId: record.providerId };
  }
  async submit(input: { orderId: string; pricing: Pricing; currency: string }) {
    requireMockMode();
    const { orderId } = input;
    const key = `order:${orderId}`;
    const record = await db.mockProviderRecord.upsert({ where: { key }, update: {},
      create: { key, orderId, operation: "ORDER", amount: input.pricing.total, state: "SUCCEEDED",
        providerId: `mock_order_${orderId}`, payload: JSON.parse(JSON.stringify({ pricing: input.pricing, currency: input.currency })) } });
    if (record.operation !== "ORDER" || record.amount !== input.pricing.total ||
      !isDeepStrictEqual(record.payload, JSON.parse(JSON.stringify({ pricing: input.pricing, currency: input.currency })))) {
      throw new Error("PROVIDER_ORDER_CONFLICT");
    }
    return { providerId: record.providerId };
  }
  async lookupOrder(orderId: string) {
    requireMockMode();
    const record = await db.mockProviderRecord.findUnique({ where: { key: `order:${orderId}` } });
    if (!record) return null;
    if (record.operation !== "ORDER" || record.orderId !== orderId) throw new Error("PROVIDER_ORDER_CONFLICT");
    return { providerId: record.providerId };
  }
  async requestPrint(orderId: string, key: string, scenario: MockScenario) {
    requireMockMode();
    if (scenario === "PRINT_UNAVAILABLE") throw new ProviderUnavailable();
    await db.mockProviderRecord.upsert({ where: { key }, update: {},
      create: { key, orderId, operation: "PRINT", amount: 0, state: "ACCEPTED", providerId: `mock_print_${key}` } });
    return { accepted: true };
  }
  async notify(orderId: string, notificationId: string) {
    requireMockMode();
    await db.inbox.upsert({ where: { source_externalId: { source: "LOCAL_NOTIFICATION", externalId: notificationId } },
      update: {}, create: { source: "LOCAL_NOTIFICATION", externalId: notificationId, payload: { orderId, template: "ORDER_PAYMENT_CONFIRMED" } } });
    console.info(JSON.stringify({ notificationId, adapter: "local" }));
  }
}

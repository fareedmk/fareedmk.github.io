export const mockScenarios = ["SUCCESS", "DECLINE", "TIMEOUT_AFTER_SUCCESS", "OUTAGE", "PRINT_UNAVAILABLE"] as const;
export type MockScenario = typeof mockScenarios[number];
export type PaymentResult = { state: "SUCCEEDED" | "DECLINED"; providerId: string };
export interface PaymentProvider {
  charge(input: { orderId: string; key: string; amount: number; scenario: MockScenario }): Promise<PaymentResult>;
  lookup(key: string): Promise<PaymentResult | null>;
  refund(input: { orderId: string; key: string; amount: number }): Promise<PaymentResult>;
}
export interface OrderProvider {
  submit(input: { orderId: string; pricing: Pricing; currency: string }): Promise<{ providerId: string }>;
  requestPrint(orderId: string, key: string, scenario: MockScenario): Promise<{ accepted: boolean }>;
}
export interface NotificationProvider {
  notify(orderId: string, notificationId: string): Promise<void>;
}
import type { Pricing } from "../domain";

import { DomainError } from "./types";

const payment = {
  UNPAID: ["PROCESSING"],
  PROCESSING: ["PAID", "FAILED", "UNKNOWN_REQUIRES_RECONCILIATION"],
  // Unknown outcomes must be reconciled, never automatically retried.
  UNKNOWN_REQUIRES_RECONCILIATION: ["PAID", "FAILED"],
  FAILED: ["PROCESSING"],
  PAID: ["PARTIALLY_REFUNDED", "REFUNDED"],
  PARTIALLY_REFUNDED: ["REFUNDED"],
  REFUNDED: [],
} as const;
const integration = {
  NOT_CREATED: ["CREATING"],
  CREATING: ["SYNCED", "RETRY_PENDING", "ACTION_REQUIRED"],
  RETRY_PENDING: ["CREATING", "ACTION_REQUIRED"],
  ACTION_REQUIRED: ["CREATING", "RETRY_PENDING", "SYNCED"],
  SYNCED: [],
} as const;
const fulfillment = {
  DRAFT: ["SUBMITTED", "CANCELLED"],
  SUBMITTED: ["ACCEPTED", "CANCELLED"],
  ACCEPTED: ["PREPARING", "CANCELLED"],
  PREPARING: ["READY", "CANCELLED"],
  READY: ["COMPLETED", "CANCELLED"],
  COMPLETED: [],
  CANCELLED: [],
} as const;

export type PaymentState = keyof typeof payment;
export type IntegrationState = keyof typeof integration;
export type FulfillmentState = keyof typeof fulfillment;
export interface StateByKind {
  payment: PaymentState;
  integration: IntegrationState;
  fulfillment: FulfillmentState;
}

/** Independent state graphs: payment success does not imply fulfillment or sync success. */
export function transitionState<K extends keyof StateByKind>(
  kind: K, from: StateByKind[K], to: StateByKind[K],
): StateByKind[K] {
  const graphs: Record<string, Record<string, readonly string[]>> = { payment, integration, fulfillment };
  const graph = graphs[kind];
  if (!graph || !Object.prototype.hasOwnProperty.call(graph, from) ||
    !Object.prototype.hasOwnProperty.call(graph, to)) {
    throw new DomainError("INVALID_STATE", `Unknown ${kind} state`);
  }
  if (from === to) return to;
  if (!graph[from].includes(to)) {
    throw new DomainError("INVALID_TRANSITION", `Cannot transition ${kind} from ${from} to ${to}`);
  }
  return to;
}

export const transitionPayment = (from: PaymentState, to: PaymentState): PaymentState =>
  transitionState("payment", from, to);
export const transitionIntegration = (from: IntegrationState, to: IntegrationState): IntegrationState =>
  transitionState("integration", from, to);
export const transitionFulfillment = (from: FulfillmentState, to: FulfillmentState): FulfillmentState =>
  transitionState("fulfillment", from, to);

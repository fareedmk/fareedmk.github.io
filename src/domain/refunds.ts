import { allocateMoney, integer, sum } from "./money";
import { DomainError, Pricing } from "./types";

export interface RefundAllocation {
  readonly amount: number;
  readonly lines: readonly { readonly lineIndex: number; readonly amount: number }[];
  readonly tip: number;
}

/**
 * Allocate an amount against remaining paid line totals and tip.
 * Pass prior allocations to prevent cumulative refunds exceeding each paid component.
 * Persistence/idempotency and refund authorization belong to the caller.
 */
export function allocateRefund(
  pricing: Pricing, amount: number, previous: readonly RefundAllocation[] = [],
): RefundAllocation {
  integer(amount, "refund amount");
  const remaining = [...pricing.lines.map((line) => integer(line.total, "line total")), integer(pricing.tip, "tip")];
  if (sum(remaining) !== pricing.total) throw new DomainError("INVALID_PRICING", "Pricing total does not reconcile");
  for (const refund of previous) {
    integer(refund.amount, "previous refund");
    integer(refund.tip, "previous tip refund");
    if (sum([...refund.lines.map((line) => integer(line.amount, "previous line refund")), refund.tip]) !== refund.amount) {
      throw new DomainError("INVALID_REFUND", "Previous refund does not reconcile");
    }
    for (const line of refund.lines) {
      integer(line.lineIndex, "lineIndex");
      if (line.lineIndex >= pricing.lines.length) throw new DomainError("INVALID_REFUND", "Unknown refund line");
      remaining[line.lineIndex] -= line.amount;
    }
    remaining[remaining.length - 1] -= refund.tip;
    if (remaining.some((value) => value < 0)) throw new DomainError("INVALID_REFUND", "Prior refunds exceed payment");
  }
  if (amount > sum(remaining)) throw new DomainError("REFUND_EXCEEDS_PAYMENT", "Refund exceeds remaining payment");
  const allocation = allocateMoney(amount, remaining);
  return Object.freeze({
    amount,
    lines: Object.freeze(pricing.lines.map((line, index) => Object.freeze({ lineIndex: line.lineIndex, amount: allocation[index] }))),
    tip: allocation[allocation.length - 1],
  });
}

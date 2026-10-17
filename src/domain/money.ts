import { DomainError } from "./types";

const MAX = BigInt(Number.MAX_SAFE_INTEGER);

export function integer(value: number, name: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new DomainError("INVALID_INTEGER", `${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

export function safe(value: bigint): number {
  if (value < BigInt(0) || value > MAX) {
    throw new DomainError("MONEY_OVERFLOW", "Money exceeds the safe integer range");
  }
  return Number(value);
}

export function sum(values: readonly number[]): number {
  return safe(values.reduce((total, value) => total + BigInt(value), BigInt(0)));
}

export function multiply(left: number, right: number): number {
  return safe(BigInt(left) * BigInt(right));
}

export function roundedRate(amount: number, numerator: number, denominator: number): number {
  return safe((BigInt(amount) * BigInt(numerator) + BigInt(denominator) / BigInt(2)) / BigInt(denominator));
}

/** Largest remainder allocation; equal remainders favor the earlier input. */
export function allocateMoney(amount: number, weights: readonly number[]): number[] {
  integer(amount, "amount");
  weights.forEach((weight) => integer(weight, "weight"));
  const total = weights.reduce((value, weight) => value + BigInt(weight), BigInt(0));
  if (total === BigInt(0)) {
    if (amount !== 0) throw new DomainError("INVALID_ALLOCATION", "Nonzero amount needs a positive weight");
    return weights.map(() => 0);
  }
  const parts = weights.map((weight, index) => {
    const numerator = BigInt(amount) * BigInt(weight);
    return { index, value: Number(numerator / total), remainder: numerator % total };
  });
  const remainder = amount - sum(parts.map((part) => part.value));
  const ranked = [...parts].sort((a, b) =>
    a.remainder === b.remainder ? a.index - b.index : a.remainder > b.remainder ? -1 : 1,
  );
  for (let index = 0; index < remainder; index++) ranked[index].value++;
  return parts.map((part) => part.value);
}

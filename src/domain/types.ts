/** Monetary amounts are integer cents. Tax rates are integer basis points. */
export interface Modifier {
  id: string;
  cloverId: string;
  name: string;
  price: number;
  available: boolean;
  maxQuantity: number;
}

export interface ModifierGroup {
  id: string;
  name: string;
  min: number;
  max: number;
  modifiers: Modifier[];
}

export interface Product {
  id: string;
  cloverId: string;
  name: string;
  categoryId: string;
  description: string;
  price: number;
  taxBps: number;
  available: boolean;
  version: number;
  groups: ModifierGroup[];
}

export interface CartLine {
  productId: string;
  quantity: number;
  modifiers: { modifierId: string; quantity: number }[];
  instructions?: string;
}

export interface Promotion {
  id: string;
  code: string;
  kind: "PERCENT" | "FIXED" | "BOGO";
  /** PERCENT is a whole percentage (10 = 10%); FIXED is cents; BOGO must be 0. */
  value: number;
  /** Minimum entire-cart subtotal, including modifiers, before discount. */
  minSpend: number;
  /** Required cap in cents; zero disables the discount. */
  maxDiscount: number;
  productIds?: string[];
  categoryIds?: string[];
  /** ISO timestamps. Dated promotions require an explicit evaluation time. */
  startsAt?: string;
  endsAt?: string;
}

export interface PricedModifier {
  readonly modifierId: string;
  readonly cloverId: string;
  readonly name: string;
  readonly quantity: number;
  readonly unitPrice: number;
  readonly total: number;
}

export interface PricedLine {
  readonly lineIndex: number;
  readonly productId: string;
  readonly cloverId: string;
  readonly categoryId: string;
  readonly name: string;
  readonly version: number;
  readonly quantity: number;
  readonly unitPrice: number;
  readonly taxBps: number;
  readonly instructions?: string;
  readonly modifiers: readonly PricedModifier[];
  readonly baseTotal: number;
  readonly modifierTotal: number;
  /** Base and modifiers before discount. */
  readonly subtotal: number;
  readonly discount: number;
  readonly tax: number;
  readonly total: number;
}

export interface Pricing {
  /** Base plus modifiers before discount. modifierTotal is informational, not additive. */
  readonly subtotal: number;
  readonly modifierTotal: number;
  readonly discount: number;
  readonly tax: number;
  readonly tip: number;
  readonly total: number;
  readonly lines: readonly PricedLine[];
}

export class DomainError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "DomainError";
  }
}

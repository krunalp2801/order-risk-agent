/**
 * The domain model. Deliberately not Shopify's shape.
 *
 * An order arrives from a storefront, an ERP or a CSV, and the rules should
 * not have to care which. `fromShopifyOrder`-style adapters belong at the
 * edge; everything inside this package speaks the types below.
 */

export interface Address {
  name?: string;
  line1: string;
  line2?: string;
  /** Split out when the source provides it. German carriers need it separately. */
  houseNumber?: string;
  postcode: string;
  city: string;
  /** ISO 3166-1 alpha-2, uppercase. */
  countryCode: string;
  phone?: string;
}

export interface LineItem {
  sku: string;
  title: string;
  quantity: number;
  unitPrice: number;
}

/**
 * What we know about the buyer at the moment the order is placed.
 *
 * These are counts rather than raw history on purpose: the rules need
 * "how many orders in the last day", not a list of orders. Keeping the
 * aggregation outside means a rule can never accidentally go and query a
 * database mid-evaluation.
 */
export interface CustomerHistory {
  email: string;
  ordersInLast24h: number;
  lifetimeOrders: number;
  chargebacks: number;
  refundedOrders: number;
}

export type ShippingMethod = "standard" | "express" | "same_day";
export type PaymentMethod = "card" | "paypal" | "invoice" | "cod" | "sofort";

export interface Order {
  id: string;
  /** Human-facing reference, e.g. "#1042". */
  name: string;
  createdAt: string;
  totalAmount: number;
  currency: string;
  lineItems: LineItem[];
  shippingAddress: Address;
  billingAddress: Address;
  shippingMethod: ShippingMethod;
  paymentMethod: PaymentMethod;
  customer: CustomerHistory;
}

/**
 * Two kinds of risk, scored separately.
 *
 * A wrong postcode and a stolen card are both "risk" in the sense that the
 * order should not ship as-is, but they need different humans and different
 * fixes. Collapsing them into one number is the mistake this package exists
 * to avoid: it means a loyal customer who typed their postcode wrong gets
 * handled by the fraud team.
 */
export type RiskKind = "fraud" | "deliverability";

export type Severity = "low" | "medium" | "high";

export interface RiskSignal {
  /** Stable id, safe to store and to aggregate on. */
  rule: string;
  kind: RiskKind;
  severity: Severity;
  /** Points this signal contributes to its kind's score. */
  weight: number;
  /** A statement of fact about the order. No verdict, no speculation. */
  detail: string;
}

export interface Rule {
  name: string;
  kind: RiskKind;
  /** Why this rule exists, shown in `--explain-rules`. */
  rationale: string;
  evaluate(order: Order): RiskSignal | null;
}

export type Band = "clear" | "review" | "hold";

export interface KindScore {
  kind: RiskKind;
  score: number;
  band: Band;
}

/**
 * What to do with the order. There is no "cancel" or "reject" here, and that
 * is the whole point: this package decides who looks at an order, never
 * whether to refuse a customer.
 */
export type Action = "release" | "review_fraud" | "fix_address" | "review_both";

export interface Assessment {
  orderId: string;
  orderName: string;
  fraud: KindScore;
  deliverability: KindScore;
  action: Action;
  signals: RiskSignal[];
  /** Prose for the human who picks this up. Never used in scoring. */
  explanation: string;
  /** Which explainer wrote it: "template" or "anthropic:<model>". */
  explainedBy: string;
  assessedAt: string;
}

export interface Thresholds {
  /** At or above this score, stop releasing automatically. */
  review: number;
  /** At or above this score, flag the item urgent. */
  hold: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = { review: 25, hold: 55 };

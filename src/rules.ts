/**
 * The rules. Every one is a pure function of a single order.
 *
 * Pure and single-order is a hard constraint, not a style preference. It is
 * what makes the score reproducible: the same order assessed twice, on two
 * machines, a month apart, produces the same number. A reviewer who disagrees
 * with a decision can be shown exactly which rules fired and why, and a rule
 * that turns out to be wrong can be re-run over historical orders to see what
 * it would have done.
 *
 * Weights are small integers chosen so that no single signal can push an
 * order past the hold threshold on its own, with two exceptions that are meant
 * to: a prior chargeback and a confirmed disposable email.
 */

import type { Order, Rule, RiskSignal } from "./types.ts";

/**
 * Postcode shapes for the countries we actually ship to. Anything not listed
 * is skipped rather than guessed, because flagging a valid Brazilian postcode
 * as malformed is worse than not checking it.
 */
const POSTCODE_FORMAT: Record<string, RegExp> = {
  AT: /^\d{4}$/,
  BE: /^\d{4}$/,
  CH: /^\d{4}$/,
  CZ: /^\d{3} ?\d{2}$/,
  DE: /^\d{5}$/,
  DK: /^\d{4}$/,
  ES: /^\d{5}$/,
  FR: /^\d{5}$/,
  GB: /^[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}$/i,
  IE: /^[A-Z]\d{2} ?[A-Z\d]{4}$/i,
  IN: /^\d{6}$/,
  IT: /^\d{5}$/,
  NL: /^\d{4} ?[A-Z]{2}$/i,
  PL: /^\d{2}-\d{3}$/,
  PT: /^\d{4}-\d{3}$/,
  SE: /^\d{3} ?\d{2}$/,
  US: /^\d{5}(-\d{4})?$/,
};

/**
 * Domains that exist to be thrown away. A short, boring list beats a clever
 * heuristic here: "looks disposable" false-positives on every small company
 * that runs its own mail server.
 */
const DISPOSABLE_EMAIL_DOMAINS = new Set([
  "10minutemail.com",
  "dispostable.com",
  "guerrillamail.com",
  "mailinator.com",
  "maildrop.cc",
  "sharklasers.com",
  "temp-mail.org",
  "tempmail.com",
  "throwawaymail.com",
  "trashmail.com",
  "yopmail.com",
]);

/** An ISO 3166-1 alpha-2 code, which is the only shape we can compare. */
const ISO_ALPHA2 = /^[A-Z]{2}$/;

/** Delivery points that are not a person's door. */
const PICKUP_POINT = /\b(packstation|postfiliale|post\s?office|paketshop|parcel\s?shop|p\.?o\.?\s?box|postfach)\b/i;

function domainOf(email: string): string {
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).trim().toLowerCase();
}

/** True when the line looks like it carries a street number. */
function hasStreetNumber(line: string): boolean {
  return /\d/.test(line);
}

const signal = (
  rule: string,
  kind: RiskSignal["kind"],
  severity: RiskSignal["severity"],
  weight: number,
  detail: string,
): RiskSignal => ({ rule, kind, severity, weight, detail });

export const RULES: Rule[] = [
  {
    name: "prior_chargeback",
    kind: "fraud",
    rationale:
      "A customer who has charged back before is the strongest single predictor available, and unlike most signals it is a fact rather than an inference.",
    evaluate(order: Order) {
      const n = order.customer.chargebacks;
      if (n < 1) return null;
      return signal(
        "prior_chargeback",
        "fraud",
        "high",
        55,
        `${order.customer.email} has ${n} prior chargeback${n === 1 ? "" : "s"}.`,
      );
    },
  },
  {
    name: "disposable_email",
    kind: "fraud",
    rationale:
      "A throwaway address means the buyer has arranged not to be contactable after the sale. Legitimate customers occasionally do this for privacy, which is why it routes to a human rather than blocking.",
    evaluate(order: Order) {
      const domain = domainOf(order.customer.email);
      if (!DISPOSABLE_EMAIL_DOMAINS.has(domain)) return null;
      return signal(
        "disposable_email",
        "fraud",
        "high",
        55,
        `Email domain ${domain} is a known disposable-mail provider.`,
      );
    },
  },
  {
    name: "billing_shipping_country_mismatch",
    kind: "fraud",
    rationale:
      "Card-not-present fraud usually ships somewhere the cardholder is not. Gifts and relocations do the same thing, so this is a review trigger, never a refusal.",
    evaluate(order: Order) {
      const ship = order.shippingAddress.countryCode.trim().toUpperCase();
      const bill = order.billingAddress.countryCode.trim().toUpperCase();
      // Only compare codes we can actually identify. "Germany" in a field
      // typed as alpha-2 is a data-quality problem, and reading it as
      // "shipping to a different country than the card" turns a broken feed
      // into a fraud alert. The `country_code_not_iso` rule catches the real
      // issue, on the deliverability side where it belongs.
      if (!ISO_ALPHA2.test(ship) || !ISO_ALPHA2.test(bill)) return null;
      if (ship === bill) return null;
      return signal(
        "billing_shipping_country_mismatch",
        "fraud",
        "high",
        30,
        `Billing country ${bill} but shipping to ${ship}.`,
      );
    },
  },
  {
    name: "order_velocity",
    kind: "fraud",
    rationale:
      "Stolen card details get tested in bursts, because the window before the card is reported is short. Three orders in a day from one address is not a shopping pattern.",
    evaluate(order: Order) {
      const n = order.customer.ordersInLast24h;
      if (n < 3) return null;
      // Grows with the burst but caps, so velocity alone cannot reach hold.
      const weight = Math.min(20 + (n - 3) * 8, 44);
      return signal(
        "order_velocity",
        "fraud",
        n >= 5 ? "high" : "medium",
        weight,
        `${n} orders from ${order.customer.email} in the last 24 hours.`,
      );
    },
  },
  {
    name: "high_value_first_order",
    kind: "fraud",
    rationale:
      "Value alone says nothing. Value on an account with no history and nothing to lose is the combination worth a look.",
    evaluate(order: Order) {
      if (order.customer.lifetimeOrders > 0) return null;
      if (order.totalAmount < 300) return null;
      const weight = order.totalAmount >= 1000 ? 30 : 20;
      return signal(
        "high_value_first_order",
        "fraud",
        "medium",
        weight,
        `First order from this customer, ${order.totalAmount.toFixed(2)} ${order.currency}.`,
      );
    },
  },
  {
    name: "pickup_point_high_value",
    kind: "fraud",
    rationale:
      "A parcel locker breaks the link between the delivery and a person who can be found, which matters for a thousand-euro parcel and not at all for a twenty-euro one.",
    evaluate(order: Order) {
      const a = order.shippingAddress;
      const target = `${a.line1} ${a.line2 ?? ""}`;
      if (!PICKUP_POINT.test(target)) return null;
      if (order.totalAmount < 150) return null;
      return signal(
        "pickup_point_high_value",
        "fraud",
        "medium",
        18,
        `Shipping ${order.totalAmount.toFixed(2)} ${order.currency} to a pickup point rather than an address.`,
      );
    },
  },
  {
    name: "expedited_first_order",
    kind: "fraud",
    rationale:
      "Paying extra to outrun the fraud check is a known pattern. On its own it is weak, which is what its weight says.",
    evaluate(order: Order) {
      if (order.shippingMethod === "standard") return null;
      if (order.customer.lifetimeOrders > 0) return null;
      return signal(
        "expedited_first_order",
        "fraud",
        "low",
        12,
        `First order, ${order.shippingMethod.replace("_", " ")} shipping.`,
      );
    },
  },
  {
    name: "quantity_outlier",
    kind: "fraud",
    rationale:
      "Ten of one SKU to a residential address is either a reseller or a resale-value test. Both are worth knowing about before the stock leaves.",
    evaluate(order: Order) {
      const worst = order.lineItems.reduce<{ sku: string; quantity: number } | null>(
        (acc, li) => (acc === null || li.quantity > acc.quantity ? { sku: li.sku, quantity: li.quantity } : acc),
        null,
      );
      if (worst === null || worst.quantity < 10) return null;
      return signal(
        "quantity_outlier",
        "fraud",
        "low",
        14,
        `${worst.quantity} units of a single SKU (${worst.sku}).`,
      );
    },
  },

  // ---- deliverability ----------------------------------------------------
  // These do not mean the buyer is dishonest. They mean the parcel will come
  // back, and the cost of that lands on the merchant either way.

  {
    name: "malformed_postcode",
    kind: "deliverability",
    rationale:
      "Carrier APIs reject a bad postcode at label creation, which is the worst moment to find out: the order is already picked and packed. Catching it at the order stage turns a failed dispatch into an email.",
    evaluate(order: Order) {
      const a = order.shippingAddress;
      const format = POSTCODE_FORMAT[a.countryCode.toUpperCase()];
      if (format === undefined) return null;
      if (format.test(a.postcode.trim())) return null;
      return signal(
        "malformed_postcode",
        "deliverability",
        "high",
        45,
        `Postcode "${a.postcode}" is not a valid ${a.countryCode.toUpperCase()} format.`,
      );
    },
  },
  {
    name: "postcode_city_swapped",
    kind: "deliverability",
    rationale:
      "Column drift in a feed or a CSV puts the postcode in the city field. It is obvious to a human and invisible to a carrier API, which simply fails the label.",
    evaluate(order: Order) {
      const a = order.shippingAddress;
      const cityLooksNumeric = /^\d{4,6}$/.test(a.city.trim());
      if (!cityLooksNumeric) return null;
      return signal(
        "postcode_city_swapped",
        "deliverability",
        "high",
        45,
        `City field contains "${a.city}", which looks like a postcode.`,
      );
    },
  },
  {
    name: "missing_street_number",
    kind: "deliverability",
    rationale:
      "German carriers treat the house number as its own field and will not guess it. An address with no digit anywhere is undeliverable, not merely untidy.",
    evaluate(order: Order) {
      const a = order.shippingAddress;
      if (a.houseNumber !== undefined && a.houseNumber.trim() !== "") return null;
      if (PICKUP_POINT.test(`${a.line1} ${a.line2 ?? ""}`)) return null; // lockers carry an id, not a number
      if (hasStreetNumber(a.line1) || hasStreetNumber(a.line2 ?? "")) return null;
      return signal(
        "missing_street_number",
        "deliverability",
        "high",
        40,
        `No house number in "${a.line1}" and none supplied separately.`,
      );
    },
  },
  {
    name: "missing_phone_for_expedited",
    kind: "deliverability",
    rationale:
      "Same-day and express couriers call the recipient. Without a number the first failed attempt becomes a return rather than a redelivery.",
    evaluate(order: Order) {
      if (order.shippingMethod === "standard") return null;
      const phone = order.shippingAddress.phone?.trim() ?? "";
      if (phone !== "") return null;
      return signal(
        "missing_phone_for_expedited",
        "deliverability",
        "medium",
        22,
        `${order.shippingMethod.replace("_", " ")} shipping with no contact number.`,
      );
    },
  },
  {
    name: "country_code_not_iso",
    kind: "deliverability",
    rationale:
      "\"Germany\" and \"DEU\" in a field typed as alpha-2 is the single most common shape of bad address data arriving from a partner feed.",
    evaluate(order: Order) {
      const cc = order.shippingAddress.countryCode.trim();
      if (ISO_ALPHA2.test(cc.toUpperCase())) return null;
      return signal(
        "country_code_not_iso",
        "deliverability",
        "medium",
        25,
        `Country "${cc}" is not an ISO 3166-1 alpha-2 code.`,
      );
    },
  },
];

/** Look a rule up by name. Useful in tests and in `--explain-rules`. */
export function ruleByName(name: string): Rule | undefined {
  return RULES.find((r) => r.name === name);
}

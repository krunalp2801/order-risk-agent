import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { RULES, ruleByName } from "../src/rules.ts";
import { signalsFor } from "../src/assess.ts";
import { order } from "./helpers.ts";
import type { RiskSignal } from "../src/types.ts";

/** Run every rule and return the signal for `name`, or undefined. */
function fired(name: string, o = order()): RiskSignal | undefined {
  return signalsFor(o).find((s) => s.rule === name);
}

describe("rule catalogue", () => {
  it("has unique rule names", () => {
    const names = RULES.map((r) => r.name);
    assert.equal(new Set(names).size, names.length);
  });

  it("every rule declares a rationale and a non-zero weight path", () => {
    for (const rule of RULES) {
      assert.ok(rule.rationale.length > 20, `${rule.name} needs a real rationale`);
      assert.ok(rule.kind === "fraud" || rule.kind === "deliverability");
    }
  });

  it("every signal carries the kind of the rule that produced it", () => {
    // A rule that returns a signal of the other kind would silently score
    // against the wrong band, which is the one mistake the split cannot survive.
    const messy = order({
      totalAmount: 2000,
      shippingMethod: "express",
      shippingAddress: { line1: "Packstation 1", postcode: "bad", city: "99999", countryCode: "Germany", phone: "" },
      customer: { email: "x@mailinator.com", ordersInLast24h: 9, lifetimeOrders: 0, chargebacks: 2, refundedOrders: 0 },
      lineItems: [{ sku: "S", title: "T", quantity: 40, unitPrice: 50 }],
    });
    for (const rule of RULES) {
      const signal = rule.evaluate(messy);
      if (signal !== null) assert.equal(signal.kind, rule.kind, rule.name);
    }
  });

  it("a clean order fires nothing", () => {
    assert.deepEqual(signalsFor(order()), []);
  });

  it("ruleByName finds a rule and misses gracefully", () => {
    assert.equal(ruleByName("prior_chargeback")?.kind, "fraud");
    assert.equal(ruleByName("no_such_rule"), undefined);
  });
});

describe("fraud rules", () => {
  it("flags a prior chargeback and counts it in the detail", () => {
    const s = fired("prior_chargeback", order({ customer: { chargebacks: 2 } }));
    assert.equal(s?.severity, "high");
    assert.match(s?.detail ?? "", /2 prior chargebacks/);
  });

  it("does not flag a customer with refunds but no chargebacks", () => {
    assert.equal(fired("prior_chargeback", order({ customer: { refundedOrders: 3 } })), undefined);
  });

  it("flags a disposable email domain, case-insensitively", () => {
    assert.ok(fired("disposable_email", order({ customer: { email: "Someone@MAILINATOR.com" } })));
    assert.equal(fired("disposable_email", order({ customer: { email: "a@gmail.com" } })), undefined);
  });

  it("flags a billing and shipping country mismatch", () => {
    const s = fired("billing_shipping_country_mismatch", order({ shippingAddress: { countryCode: "IN" } }));
    assert.match(s?.detail ?? "", /Billing country DE but shipping to IN/);
  });

  it("ignores case and whitespace when comparing countries", () => {
    const o = order({ shippingAddress: { countryCode: " de " }, billingAddress: { countryCode: "DE" } });
    assert.equal(fired("billing_shipping_country_mismatch", o), undefined);
  });

  it("refuses to compare countries it cannot identify", () => {
    // "Germany" against "DE" is a broken feed, not a fraud signal. Reading it
    // as a mismatch was a real bug in this file's first version.
    const o = order({ shippingAddress: { countryCode: "Germany" }, billingAddress: { countryCode: "DE" } });
    assert.equal(fired("billing_shipping_country_mismatch", o), undefined);
    assert.ok(fired("country_code_not_iso", o), "the data problem should still be reported");
  });

  it("scores velocity above three orders and caps the growth", () => {
    assert.equal(fired("order_velocity", order({ customer: { ordersInLast24h: 2 } })), undefined);
    const three = fired("order_velocity", order({ customer: { ordersInLast24h: 3 } }));
    const fifty = fired("order_velocity", order({ customer: { ordersInLast24h: 50 } }));
    assert.equal(three?.weight, 20);
    assert.equal(fifty?.weight, 44);
    assert.equal(fifty?.severity, "high");
  });

  it("flags high value only on a first order", () => {
    assert.ok(fired("high_value_first_order", order({ totalAmount: 500, customer: { lifetimeOrders: 0 } })));
    assert.equal(fired("high_value_first_order", order({ totalAmount: 500, customer: { lifetimeOrders: 1 } })), undefined);
    assert.equal(fired("high_value_first_order", order({ totalAmount: 299, customer: { lifetimeOrders: 0 } })), undefined);
  });

  it("weights a four-figure first order higher", () => {
    const mid = fired("high_value_first_order", order({ totalAmount: 500, customer: { lifetimeOrders: 0 } }));
    const big = fired("high_value_first_order", order({ totalAmount: 1000, customer: { lifetimeOrders: 0 } }));
    assert.ok((big?.weight ?? 0) > (mid?.weight ?? 0));
  });

  it("flags a pickup point only above the value floor", () => {
    const high = order({ totalAmount: 400, shippingAddress: { line1: "Packstation 142" } });
    const low = order({ totalAmount: 20, shippingAddress: { line1: "Packstation 142" } });
    assert.ok(fired("pickup_point_high_value", high));
    assert.equal(fired("pickup_point_high_value", low), undefined);
  });

  it("recognises the German locker and PO box spellings", () => {
    for (const line1 of ["Packstation 142", "Postfiliale 503", "Postfach 1100", "P.O. Box 22", "DHL Paketshop 9"]) {
      const o = order({ totalAmount: 400, shippingAddress: { line1 } });
      assert.ok(fired("pickup_point_high_value", o), line1);
    }
  });

  it("flags expedited shipping only for a first order", () => {
    assert.ok(fired("expedited_first_order", order({ shippingMethod: "express", customer: { lifetimeOrders: 0 } })));
    assert.equal(fired("expedited_first_order", order({ shippingMethod: "express" })), undefined);
    assert.equal(fired("expedited_first_order", order({ customer: { lifetimeOrders: 0 } })), undefined);
  });

  it("flags a quantity outlier on the largest line and names the SKU", () => {
    const o = order({
      lineItems: [
        { sku: "SMALL", title: "a", quantity: 2, unitPrice: 1 },
        { sku: "BULK", title: "b", quantity: 14, unitPrice: 1 },
      ],
    });
    assert.match(fired("quantity_outlier", o)?.detail ?? "", /14 units of a single SKU \(BULK\)/);
  });

  it("does not flag a spread-out order with the same total units", () => {
    const o = order({
      lineItems: Array.from({ length: 8 }, (_, i) => ({ sku: `S${i}`, title: "x", quantity: 3, unitPrice: 1 })),
    });
    assert.equal(fired("quantity_outlier", o), undefined);
  });
});

describe("deliverability rules", () => {
  it("accepts the postcode formats of the countries we ship to", () => {
    const valid: Array<[string, string]> = [
      ["DE", "60311"], ["AT", "1010"], ["NL", "1012 AB"], ["NL", "1012ab"],
      ["GB", "SW1A 1AA"], ["GB", "M1 1AE"], ["FR", "75001"], ["PL", "00-001"],
      ["PT", "1000-001"], ["SE", "111 22"], ["US", "10001"], ["US", "10001-1234"],
      ["IN", "380015"], ["IE", "D02 AF30"], ["CZ", "110 00"],
    ];
    for (const [countryCode, postcode] of valid) {
      const o = order({ shippingAddress: { countryCode, postcode } });
      assert.equal(fired("malformed_postcode", o), undefined, `${countryCode} ${postcode}`);
    }
  });

  it("flags a malformed postcode", () => {
    for (const [countryCode, postcode] of [["DE", "6031"], ["DE", "ABCDE"], ["GB", "SW1A"], ["NL", "1012"]]) {
      const o = order({ shippingAddress: { countryCode: countryCode as string, postcode: postcode as string } });
      assert.ok(fired("malformed_postcode", o), `${countryCode} ${postcode}`);
    }
  });

  it("skips the postcode check for countries whose format it does not know", () => {
    // Better to check nothing than to call a valid Brazilian postcode broken.
    const o = order({ shippingAddress: { countryCode: "BR", postcode: "01310-100" } });
    assert.equal(fired("malformed_postcode", o), undefined);
  });

  it("tolerates surrounding whitespace in a postcode", () => {
    const o = order({ shippingAddress: { postcode: " 60311 " } });
    assert.equal(fired("malformed_postcode", o), undefined);
  });

  it("spots a postcode sitting in the city column", () => {
    const o = order({ shippingAddress: { postcode: "Koeln", city: "50667" } });
    assert.ok(fired("postcode_city_swapped", o));
    assert.ok(fired("malformed_postcode", o), "both halves of the swap should be reported");
  });

  it("does not mistake a numbered city for a swap", () => {
    assert.equal(fired("postcode_city_swapped", order({ shippingAddress: { city: "Frankfurt 60311" } })), undefined);
  });

  it("flags a street with no house number", () => {
    assert.ok(fired("missing_street_number", order({ shippingAddress: { line1: "Hauptstrasse" } })));
  });

  it("accepts a house number from line1, line2 or its own field", () => {
    assert.equal(fired("missing_street_number", order({ shippingAddress: { line1: "Hauptstrasse 22" } })), undefined);
    assert.equal(fired("missing_street_number", order({ shippingAddress: { line1: "Hauptstrasse", line2: "Haus 4" } })), undefined);
    assert.equal(fired("missing_street_number", order({ shippingAddress: { line1: "Hauptstrasse", houseNumber: "22a" } })), undefined);
  });

  it("does not demand a house number for a parcel locker", () => {
    const o = order({ shippingAddress: { line1: "Packstation", houseNumber: "" } });
    assert.equal(fired("missing_street_number", o), undefined);
  });

  it("flags a missing phone number only for expedited shipping", () => {
    assert.ok(fired("missing_phone_for_expedited", order({ shippingMethod: "same_day", shippingAddress: { phone: "" } })));
    assert.equal(fired("missing_phone_for_expedited", order({ shippingAddress: { phone: "" } })), undefined);
    assert.equal(fired("missing_phone_for_expedited", order({ shippingMethod: "express" })), undefined);
  });

  it("treats a whitespace-only phone number as missing", () => {
    const o = order({ shippingMethod: "express", shippingAddress: { phone: "   " } });
    assert.ok(fired("missing_phone_for_expedited", o));
  });

  it("flags a country that is not an alpha-2 code", () => {
    for (const countryCode of ["Germany", "DEU", "D", ""]) {
      assert.ok(fired("country_code_not_iso", order({ shippingAddress: { countryCode } })), countryCode);
    }
    assert.equal(fired("country_code_not_iso", order({ shippingAddress: { countryCode: "de" } })), undefined);
  });
});

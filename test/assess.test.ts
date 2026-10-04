import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { assess, assessAll, signalsFor } from "../src/assess.ts";
import { DEMO_ORDERS } from "../src/fixtures.ts";
import { ReviewQueue } from "../src/queue.ts";
import { RULES } from "../src/rules.ts";
import { order } from "./helpers.ts";
import type { Rule } from "../src/types.ts";

describe("assess", () => {
  it("releases a clean order with both scores at zero", async () => {
    const a = await assess(order());
    assert.equal(a.action, "release");
    assert.equal(a.fraud.score, 0);
    assert.equal(a.deliverability.score, 0);
    assert.deepEqual(a.signals, []);
  });

  it("carries the order identity and the explainer id through", async () => {
    const a = await assess(order({ id: "gid://order/42", name: "#42" }));
    assert.equal(a.orderId, "gid://order/42");
    assert.equal(a.orderName, "#42");
    assert.equal(a.explainedBy, "template");
  });

  it("stamps the assessment time from the injected clock", async () => {
    const a = await assess(order(), { now: () => "2026-01-01T00:00:00.000Z" });
    assert.equal(a.assessedAt, "2026-01-01T00:00:00.000Z");
  });

  it("is reproducible: the same order twice gives the same scores", async () => {
    const o = DEMO_ORDERS[3];
    assert.ok(o);
    const first = await assess(o, { now: () => "t" });
    const second = await assess(o, { now: () => "t" });
    assert.deepEqual(first, second);
  });

  it("accepts a custom rule set, which is how a backtest works", async () => {
    const onlyRule: Rule[] = [
      {
        name: "always",
        kind: "fraud",
        rationale: "test rule that always fires so the wiring is observable",
        evaluate: () => ({ rule: "always", kind: "fraud", severity: "low", weight: 30, detail: "d" }),
      },
    ];
    const a = await assess(order(), { rules: onlyRule });
    assert.equal(a.fraud.score, 30);
    assert.equal(a.action, "review_fraud");
  });

  it("honours custom thresholds", async () => {
    const o = order({ customer: { ordersInLast24h: 3 } }); // weight 20, below default review
    assert.equal((await assess(o)).action, "release");
    assert.equal((await assess(o, { thresholds: { review: 10, hold: 90 } })).action, "review_fraud");
  });
});

describe("the fraud and address scores stay separate", () => {
  it("scores a wrong postcode as an address problem and not as fraud", async () => {
    // The case the whole design exists for: a long-standing customer who
    // typed their postcode wrong must not reach the fraud team.
    const a = await assess(order({ shippingAddress: { postcode: "606" } }));
    assert.equal(a.fraud.score, 0);
    assert.ok(a.deliverability.score > 0);
    assert.equal(a.action, "fix_address");
  });

  it("scores a chargeback as fraud and not as an address problem", async () => {
    const a = await assess(order({ customer: { chargebacks: 1 } }));
    assert.equal(a.deliverability.score, 0);
    assert.equal(a.action, "review_fraud");
  });

  it("routes an order with both to both", async () => {
    const a = await assess(order({
      customer: { chargebacks: 1 },
      shippingAddress: { postcode: "606" },
    }));
    assert.equal(a.action, "review_both");
  });
});

describe("assessAll over the demo fixtures", () => {
  it("assesses every order", async () => {
    const all = await assessAll(DEMO_ORDERS);
    assert.equal(all.length, DEMO_ORDERS.length);
    assert.deepEqual(all.map((a) => a.orderName), DEMO_ORDERS.map((o) => o.name));
  });

  it("writes a note for every order, including the clean ones", async () => {
    for (const a of await assessAll(DEMO_ORDERS)) {
      assert.ok(a.explanation.trim().length > 0, a.orderName);
    }
  });

  it("releases some and flags some, so the rules discriminate", async () => {
    const all = await assessAll(DEMO_ORDERS);
    const released = all.filter((a) => a.action === "release");
    assert.ok(released.length >= 1, "nothing was released");
    assert.ok(released.length < all.length, "nothing was flagged");
  });

  it("produces every action across the fixture set", async () => {
    // If a fixture set never exercises an action, the demo is not showing
    // what the thing does.
    const actions = new Set((await assessAll(DEMO_ORDERS)).map((a) => a.action));
    assert.deepEqual([...actions].sort(), ["fix_address", "release", "review_both", "review_fraud"]);
  });

  it("feeds straight into the review queue", async () => {
    const q = new ReviewQueue(() => "2026-01-01T00:00:00.000Z");
    for (const a of await assessAll(DEMO_ORDERS)) q.enqueue(a);
    const stats = q.stats();
    assert.equal(stats.pending + stats.released, DEMO_ORDERS.length);
    const pending = q.pending();
    // Worst first, so a reviewer opening the queue sees the real problem.
    const priorities = pending.map((i) => i.priority);
    assert.deepEqual(priorities, [...priorities].sort((a, b) => b - a));
  });
});

describe("signalsFor", () => {
  it("runs the full catalogue and returns them in rule order", async () => {
    const o = order({ customer: { chargebacks: 1, ordersInLast24h: 5 } });
    const names = signalsFor(o).map((s) => s.rule);
    const catalogue = RULES.map((r) => r.name);
    assert.deepEqual(names, catalogue.filter((n) => names.includes(n)));
  });

  it("returns an empty array rather than nulls", () => {
    assert.deepEqual(signalsFor(order()), []);
  });
});

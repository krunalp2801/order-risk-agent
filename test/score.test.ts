import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { actionFor, bandFor, kindScore, scoreFor, thresholdsFromEnv } from "../src/score.ts";
import { DEFAULT_THRESHOLDS } from "../src/types.ts";
import type { KindScore, RiskSignal } from "../src/types.ts";

const sig = (kind: RiskSignal["kind"], weight: number): RiskSignal => ({
  rule: `r${weight}`,
  kind,
  severity: "medium",
  weight,
  detail: "d",
});

const ks = (score: number): KindScore => ({ kind: "fraud", score, band: bandFor(score) });

describe("scoreFor", () => {
  it("sums only the signals of the requested kind", () => {
    const signals = [sig("fraud", 30), sig("deliverability", 40), sig("fraud", 10)];
    assert.equal(scoreFor(signals, "fraud"), 40);
    assert.equal(scoreFor(signals, "deliverability"), 40);
  });

  it("is zero with no signals", () => {
    assert.equal(scoreFor([], "fraud"), 0);
  });

  it("clamps at 100 so the number stays readable", () => {
    assert.equal(scoreFor([sig("fraud", 90), sig("fraud", 90)], "fraud"), 100);
  });
});

describe("bandFor", () => {
  it("bands on the thresholds, inclusive at the boundary", () => {
    assert.equal(bandFor(0), "clear");
    assert.equal(bandFor(24), "clear");
    assert.equal(bandFor(25), "review");
    assert.equal(bandFor(54), "review");
    assert.equal(bandFor(55), "hold");
    assert.equal(bandFor(100), "hold");
  });

  it("honours custom thresholds", () => {
    assert.equal(bandFor(10, { review: 5, hold: 80 }), "review");
    assert.equal(bandFor(79, { review: 5, hold: 80 }), "review");
    assert.equal(bandFor(80, { review: 5, hold: 80 }), "hold");
  });
});

describe("kindScore", () => {
  it("reports the kind, the score and the band together", () => {
    assert.deepEqual(kindScore([sig("deliverability", 45)], "deliverability"), {
      kind: "deliverability",
      score: 45,
      band: "review",
    });
  });
});

describe("actionFor", () => {
  it("releases when both bands are clear", () => {
    assert.equal(actionFor(ks(0), ks(24)), "release");
  });

  it("routes fraud, address and both separately", () => {
    assert.equal(actionFor(ks(60), ks(0)), "review_fraud");
    assert.equal(actionFor(ks(0), ks(60)), "fix_address");
    assert.equal(actionFor(ks(30), ks(30)), "review_both");
  });

  it("never produces an action that refuses the order", () => {
    // The strongest outcome available is "two people should look at this".
    const outcomes = new Set<string>();
    for (const f of [0, 25, 55, 100]) {
      for (const d of [0, 25, 55, 100]) outcomes.add(actionFor(ks(f), ks(d)));
    }
    assert.deepEqual(
      [...outcomes].sort(),
      ["fix_address", "release", "review_both", "review_fraud"],
    );
  });
});

describe("thresholdsFromEnv", () => {
  it("falls back to the defaults", () => {
    assert.deepEqual(thresholdsFromEnv({}), DEFAULT_THRESHOLDS);
  });

  it("reads both thresholds", () => {
    assert.deepEqual(
      thresholdsFromEnv({ RISK_REVIEW_THRESHOLD: "10", RISK_HOLD_THRESHOLD: "40" }),
      { review: 10, hold: 40 },
    );
  });

  it("ignores values that are not positive numbers", () => {
    assert.deepEqual(
      thresholdsFromEnv({ RISK_REVIEW_THRESHOLD: "abc", RISK_HOLD_THRESHOLD: "-5" }),
      DEFAULT_THRESHOLDS,
    );
  });

  it("refuses to let hold sit below review", () => {
    // Otherwise "review" is unreachable and every flagged order looks urgent.
    const t = thresholdsFromEnv({ RISK_REVIEW_THRESHOLD: "60", RISK_HOLD_THRESHOLD: "20" });
    assert.deepEqual(t, { review: 60, hold: 60 });
  });
});

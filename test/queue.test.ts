import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { AlreadyDecidedError, ReviewQueue } from "../src/queue.ts";
import { bandFor } from "../src/score.ts";
import { actionFor } from "../src/score.ts";
import type { Assessment, Action } from "../src/types.ts";
import { fixedClock } from "./helpers.ts";

function assessment(id: string, fraudScore: number, addressScore: number): Assessment {
  const fraud = { kind: "fraud" as const, score: fraudScore, band: bandFor(fraudScore) };
  const deliverability = { kind: "deliverability" as const, score: addressScore, band: bandFor(addressScore) };
  return {
    orderId: id,
    orderName: `#${id}`,
    fraud,
    deliverability,
    action: actionFor(fraud, deliverability),
    signals: [],
    explanation: "note",
    explainedBy: "template",
    assessedAt: "2026-09-29T12:00:00.000Z",
  };
}

describe("ReviewQueue routing", () => {
  it("does not queue a released order", () => {
    const q = new ReviewQueue(fixedClock());
    assert.equal(q.enqueue(assessment("a", 0, 0)), null);
    assert.deepEqual(q.pending(), []);
    assert.equal(q.stats().released, 1);
  });

  it("queues anything not released", () => {
    const q = new ReviewQueue(fixedClock());
    assert.ok(q.enqueue(assessment("a", 60, 0)));
    assert.ok(q.enqueue(assessment("b", 0, 60)));
    assert.equal(q.pending().length, 2);
  });

  it("prioritises on the higher of the two scores", () => {
    const q = new ReviewQueue(fixedClock());
    q.enqueue(assessment("low", 30, 0));
    q.enqueue(assessment("high", 0, 95));
    q.enqueue(assessment("mid", 50, 50));
    assert.deepEqual(q.pending().map((i) => i.assessment.orderId), ["high", "mid", "low"]);
  });

  it("breaks priority ties on order id so the order is stable", () => {
    const q = new ReviewQueue(fixedClock());
    q.enqueue(assessment("zzz", 40, 0));
    q.enqueue(assessment("aaa", 40, 0));
    assert.deepEqual(q.pending().map((i) => i.assessment.orderId), ["aaa", "zzz"]);
  });

  it("filters by what kind of attention is needed", () => {
    const q = new ReviewQueue(fixedClock());
    q.enqueue(assessment("fraud-only", 60, 0));
    q.enqueue(assessment("address-only", 0, 60));
    q.enqueue(assessment("both", 60, 60));
    const ids = (a: Action): string[] => q.pendingFor(a).map((i) => i.assessment.orderId);
    assert.deepEqual(ids("review_fraud"), ["fraud-only"]);
    assert.deepEqual(ids("fix_address"), ["address-only"]);
    assert.deepEqual(ids("review_both"), ["both"]);
  });

  it("records when an item was queued", () => {
    const q = new ReviewQueue(fixedClock("2026-01-01T00:00:00.000Z"));
    const item = q.enqueue(assessment("a", 60, 0));
    assert.equal(item?.queuedAt, "2026-01-01T00:00:00.000Z");
  });
});

describe("ReviewQueue decisions", () => {
  it("records who decided, when, and the note", () => {
    const q = new ReviewQueue(fixedClock("2026-01-01T00:00:00.000Z"));
    q.enqueue(assessment("a", 60, 0));
    const decided = q.approve("a", "cs@example.com", "Confirmed by phone.");
    assert.equal(decided.state, "approved");
    assert.equal(decided.decision?.by, "cs@example.com");
    assert.equal(decided.decision?.note, "Confirmed by phone.");
    assert.equal(decided.decision?.at, "2026-01-01T00:00:01.000Z");
  });

  it("allows a decision with no note", () => {
    const q = new ReviewQueue(fixedClock());
    q.enqueue(assessment("a", 60, 0));
    assert.equal(q.reject("a", "fraud@example.com").decision?.note, undefined);
  });

  it("drops a decided item out of pending", () => {
    const q = new ReviewQueue(fixedClock());
    q.enqueue(assessment("a", 60, 0));
    q.approve("a", "someone");
    assert.deepEqual(q.pending(), []);
    assert.equal(q.get("a")?.state, "approved");
  });

  it("refuses a second decision rather than overwriting the first", () => {
    const q = new ReviewQueue(fixedClock());
    q.enqueue(assessment("a", 60, 0));
    q.approve("a", "first@example.com");
    assert.throws(() => q.reject("a", "second@example.com"), AlreadyDecidedError);
    assert.equal(q.get("a")?.decision?.by, "first@example.com");
  });

  it("names the order and the existing state in the error", () => {
    const q = new ReviewQueue(fixedClock());
    q.enqueue(assessment("a", 60, 0));
    q.reject("a", "x");
    try {
      q.approve("a", "y");
      assert.fail("expected AlreadyDecidedError");
    } catch (err) {
      assert.ok(err instanceof AlreadyDecidedError);
      assert.equal(err.orderId, "a");
      assert.equal(err.state, "rejected");
    }
  });

  it("throws on an order it has never seen", () => {
    const q = new ReviewQueue(fixedClock());
    assert.throws(() => q.approve("ghost", "x"), /not in the review queue/);
  });
});

describe("ReviewQueue re-assessment", () => {
  it("updates a pending item in place and keeps the original queue time", () => {
    const q = new ReviewQueue(fixedClock("2026-01-01T00:00:00.000Z"));
    q.enqueue(assessment("a", 30, 0));
    const again = q.enqueue(assessment("a", 90, 0));
    assert.equal(q.pending().length, 1);
    assert.equal(again?.priority, 90);
    assert.equal(again?.queuedAt, "2026-01-01T00:00:00.000Z");
  });

  it("will not resurrect a decided item", () => {
    // A reviewer's approval stands even if the rules later score it higher.
    const q = new ReviewQueue(fixedClock());
    q.enqueue(assessment("a", 30, 0));
    q.approve("a", "cs@example.com");
    const again = q.enqueue(assessment("a", 95, 0));
    assert.equal(again?.state, "approved");
    assert.deepEqual(q.pending(), []);
  });

  it("counts a release even for an order that was previously flagged", () => {
    const q = new ReviewQueue(fixedClock());
    q.enqueue(assessment("a", 60, 0));
    q.enqueue(assessment("a", 0, 0));
    assert.equal(q.stats().released, 1);
  });
});

describe("ReviewQueue stats", () => {
  it("counts each state", () => {
    const q = new ReviewQueue(fixedClock());
    q.enqueue(assessment("clean", 0, 0));
    q.enqueue(assessment("a", 60, 0));
    q.enqueue(assessment("b", 60, 0));
    q.enqueue(assessment("c", 60, 0));
    q.approve("a", "x");
    q.reject("b", "y");
    assert.deepEqual(q.stats(), { pending: 1, approved: 1, rejected: 1, released: 1 });
  });
});

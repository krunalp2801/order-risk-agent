/**
 * The human review queue.
 *
 * In-memory and deliberately small. The interesting part of a review queue is
 * not where the rows live, it is the state machine: an item is pending until
 * exactly one person decides it, decisions are recorded with who and when,
 * and a decided item cannot quietly be decided again. Those properties are
 * worth testing and are independent of the storage, so the storage is a Map
 * and swapping it for Postgres is a `ReviewStore` interface away.
 */

import type { Assessment, Action } from "./types.ts";

export type ReviewState = "pending" | "approved" | "rejected";

export interface Decision {
  state: Exclude<ReviewState, "pending">;
  by: string;
  at: string;
  note?: string;
}

export interface ReviewItem {
  assessment: Assessment;
  state: ReviewState;
  /** Highest of the two scores, which is what sorts the queue. */
  priority: number;
  queuedAt: string;
  decision?: Decision;
}

export class AlreadyDecidedError extends Error {
  readonly orderId: string;
  readonly state: ReviewState;

  constructor(orderId: string, state: ReviewState) {
    super(`Order ${orderId} was already ${state}. Re-deciding would lose the first decision.`);
    this.name = "AlreadyDecidedError";
    this.orderId = orderId;
    this.state = state;
  }
}

export interface QueueStats {
  pending: number;
  approved: number;
  rejected: number;
  /** Released without ever entering the queue. */
  released: number;
}

export class ReviewQueue {
  // Fields declared and assigned rather than written as constructor parameter
  // properties: those are a code transform, not a type annotation, and Node's
  // --experimental-strip-types refuses them. Week 1 of this series found that
  // out the hard way.
  private readonly items: Map<string, ReviewItem>;
  private readonly now: () => string;
  private releasedCount: number;

  constructor(now?: () => string) {
    this.items = new Map();
    this.now = now ?? (() => new Date().toISOString());
    this.releasedCount = 0;
  }

  /**
   * Route an assessment. Returns the queued item, or null when the order was
   * released and no human needs to see it.
   */
  enqueue(assessment: Assessment): ReviewItem | null {
    if (assessment.action === "release") {
      this.releasedCount += 1;
      return null;
    }
    const existing = this.items.get(assessment.orderId);
    // Re-assessing an order already in the queue updates the assessment but
    // must not resurrect a decided item: a reviewer's approval stands even if
    // the rules later change their mind.
    if (existing !== undefined && existing.state !== "pending") return existing;

    const item: ReviewItem = {
      assessment,
      state: "pending",
      priority: Math.max(assessment.fraud.score, assessment.deliverability.score),
      queuedAt: existing?.queuedAt ?? this.now(),
    };
    this.items.set(assessment.orderId, item);
    return item;
  }

  get(orderId: string): ReviewItem | undefined {
    return this.items.get(orderId);
  }

  /** Pending items, worst first. Ties break on order id so the order is stable. */
  pending(): ReviewItem[] {
    return [...this.items.values()]
      .filter((i) => i.state === "pending")
      .sort((a, b) =>
        b.priority - a.priority ||
        a.assessment.orderId.localeCompare(b.assessment.orderId),
      );
  }

  /** Pending items needing a particular kind of attention. */
  pendingFor(action: Action): ReviewItem[] {
    return this.pending().filter((i) => i.assessment.action === action);
  }

  decide(
    orderId: string,
    state: Exclude<ReviewState, "pending">,
    by: string,
    note?: string,
  ): ReviewItem {
    const item = this.items.get(orderId);
    if (item === undefined) throw new Error(`Order ${orderId} is not in the review queue.`);
    if (item.state !== "pending") throw new AlreadyDecidedError(orderId, item.state);

    const decision: Decision = note === undefined
      ? { state, by, at: this.now() }
      : { state, by, at: this.now(), note };
    const decided: ReviewItem = { ...item, state, decision };
    this.items.set(orderId, decided);
    return decided;
  }

  approve(orderId: string, by: string, note?: string): ReviewItem {
    return this.decide(orderId, "approved", by, note);
  }

  reject(orderId: string, by: string, note?: string): ReviewItem {
    return this.decide(orderId, "rejected", by, note);
  }

  stats(): QueueStats {
    const all = [...this.items.values()];
    return {
      pending: all.filter((i) => i.state === "pending").length,
      approved: all.filter((i) => i.state === "approved").length,
      rejected: all.filter((i) => i.state === "rejected").length,
      released: this.releasedCount,
    };
  }
}

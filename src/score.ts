/**
 * Turning signals into a score, a band and an action.
 *
 * All four functions here are pure and synchronous, so the routing logic can
 * be tested exhaustively without constructing an order, a client or a clock.
 */

import type { Action, Band, KindScore, RiskKind, RiskSignal, Thresholds } from "./types.ts";
import { DEFAULT_THRESHOLDS } from "./types.ts";

/**
 * Sum the weights for one kind, clamped to 100.
 *
 * Summing is the honest choice given what the weights are: hand-set numbers
 * reflecting how much each signal should matter, not calibrated
 * probabilities. A Bayesian combination would imply the inputs are
 * independent and the priors are known, and neither is true. The clamp exists
 * so the number stays readable to a reviewer rather than reaching 180.
 */
export function scoreFor(signals: RiskSignal[], kind: RiskKind): number {
  const total = signals
    .filter((s) => s.kind === kind)
    .reduce((sum, s) => sum + s.weight, 0);
  return Math.min(total, 100);
}

export function bandFor(score: number, thresholds: Thresholds = DEFAULT_THRESHOLDS): Band {
  if (score >= thresholds.hold) return "hold";
  if (score >= thresholds.review) return "review";
  return "clear";
}

export function kindScore(
  signals: RiskSignal[],
  kind: RiskKind,
  thresholds: Thresholds = DEFAULT_THRESHOLDS,
): KindScore {
  const score = scoreFor(signals, kind);
  return { kind, score, band: bandFor(score, thresholds) };
}

/**
 * Which queue the order belongs in.
 *
 * Note what is absent: there is no action that cancels, refunds or refuses an
 * order. The worst thing this function can decide is that two different people
 * need to look at something. Automated refusal of a customer's order is a
 * decision with a legal and a reputational cost, and it needs a human whose
 * job that is.
 */
export function actionFor(fraud: KindScore, deliverability: KindScore): Action {
  const fraudFlagged = fraud.band !== "clear";
  const addressFlagged = deliverability.band !== "clear";
  if (fraudFlagged && addressFlagged) return "review_both";
  if (fraudFlagged) return "review_fraud";
  if (addressFlagged) return "fix_address";
  return "release";
}

/** Read thresholds from the environment, falling back to the defaults. */
export function thresholdsFromEnv(env: Record<string, string | undefined>): Thresholds {
  const num = (raw: string | undefined, fallback: number): number => {
    if (raw === undefined) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  const review = num(env["RISK_REVIEW_THRESHOLD"], DEFAULT_THRESHOLDS.review);
  const hold = num(env["RISK_HOLD_THRESHOLD"], DEFAULT_THRESHOLDS.hold);
  // A hold threshold below the review threshold would make "review"
  // unreachable; treat that as a misconfiguration and keep them ordered.
  return hold >= review ? { review, hold } : { review, hold: review };
}

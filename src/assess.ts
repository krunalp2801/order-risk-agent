/**
 * The pipeline: rules, then scores, then routing, then prose.
 *
 * Reading top to bottom is the point. Each stage takes the previous stage's
 * output and nothing else, which is what lets the explainer sit at the end
 * with no way to reach back into the decision.
 */

import { RULES } from "./rules.ts";
import { actionFor, kindScore } from "./score.ts";
import { templateExplainer } from "./explain.ts";
import type { Explainer, ExplainRequest } from "./explain.ts";
import { DEFAULT_THRESHOLDS } from "./types.ts";
import type { Assessment, Order, RiskSignal, Rule, Thresholds } from "./types.ts";

export interface AssessOptions {
  rules?: Rule[];
  explainer?: Explainer;
  thresholds?: Thresholds;
  now?: () => string;
}

/** Run the rules. Separated out because it is useful on its own, in a backtest. */
export function signalsFor(order: Order, rules: Rule[] = RULES): RiskSignal[] {
  const out: RiskSignal[] = [];
  for (const rule of rules) {
    const signal = rule.evaluate(order);
    if (signal !== null) out.push(signal);
  }
  return out;
}

export async function assess(order: Order, options: AssessOptions = {}): Promise<Assessment> {
  const rules = options.rules ?? RULES;
  const explainer = options.explainer ?? templateExplainer;
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const now = options.now ?? (() => new Date().toISOString());

  const signals = signalsFor(order, rules);
  const fraud = kindScore(signals, "fraud", thresholds);
  const deliverability = kindScore(signals, "deliverability", thresholds);
  const action = actionFor(fraud, deliverability);

  const request: ExplainRequest = { order, signals, fraud, deliverability, action };
  const explanation = await explainer.explain(request);

  return {
    orderId: order.id,
    orderName: order.name,
    fraud,
    deliverability,
    action,
    signals,
    explanation,
    explainedBy: explainer.id,
    assessedAt: now(),
  };
}

/**
 * Assess a batch, sequentially.
 *
 * Sequential rather than Promise.all: with the LLM explainer, a batch of a
 * few hundred orders fired at once is a rate-limit incident. Concurrency
 * belongs behind a limiter, and that is on the roadmap rather than faked here.
 */
export async function assessAll(orders: Order[], options: AssessOptions = {}): Promise<Assessment[]> {
  const out: Assessment[] = [];
  for (const order of orders) out.push(await assess(order, options));
  return out;
}

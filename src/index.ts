/**
 * Public surface. Import from here rather than from the modules directly.
 */

export { assess, assessAll, signalsFor } from "./assess.ts";
export type { AssessOptions } from "./assess.ts";
export { RULES, ruleByName } from "./rules.ts";
export { actionFor, bandFor, kindScore, scoreFor, thresholdsFromEnv } from "./score.ts";
export {
  anthropicExplainer,
  buildPrompt,
  resolveExplainer,
  templateExplainer,
} from "./explain.ts";
export type { AnthropicExplainerOptions, ExplainRequest, Explainer } from "./explain.ts";
export { AlreadyDecidedError, ReviewQueue } from "./queue.ts";
export type { Decision, QueueStats, ReviewItem, ReviewState } from "./queue.ts";
export { DEFAULT_THRESHOLDS } from "./types.ts";
export type {
  Action,
  Address,
  Assessment,
  Band,
  CustomerHistory,
  KindScore,
  LineItem,
  Order,
  PaymentMethod,
  Rule,
  RiskKind,
  RiskSignal,
  Severity,
  ShippingMethod,
  Thresholds,
} from "./types.ts";

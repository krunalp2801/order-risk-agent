/**
 * Writing the note the reviewer reads.
 *
 * This is the only place an LLM appears in this package, and it is downstream
 * of every decision. The explainer receives the signals and the scores as
 * inputs and returns prose. It cannot change a score, add a signal or alter
 * the routing, because nothing it returns is fed back in. `explain.test.ts`
 * asserts that: the same order assessed with the template explainer and with
 * a deliberately hostile explainer produces byte-identical scores.
 *
 * The reason to build it this way is that the two jobs have different failure
 * costs. Getting a score wrong routes an order to the wrong person. Getting a
 * sentence wrong wastes ten seconds of their time. Only the second job is
 * safe to hand to a model that cannot show its work.
 */

import type { Assessment, KindScore, Order, RiskSignal } from "./types.ts";

export interface ExplainRequest {
  order: Order;
  signals: RiskSignal[];
  fraud: KindScore;
  deliverability: KindScore;
  action: Assessment["action"];
}

export interface Explainer {
  /** Recorded on the assessment so you can tell later who wrote the note. */
  readonly id: string;
  explain(req: ExplainRequest): Promise<string>;
}

const ACTION_LEAD: Record<Assessment["action"], string> = {
  release: "No review needed.",
  review_fraud: "Needs a payment review before dispatch.",
  fix_address: "Address needs fixing before a label is bought.",
  review_both: "Needs a payment review and an address fix.",
};

/**
 * The default. Deterministic, offline, and good enough that the LLM is a
 * genuine upgrade rather than a requirement.
 *
 * Writing this first was a useful discipline: it forced the signal `detail`
 * strings to be complete sentences that stand on their own, which in turn is
 * what makes the LLM prompt short and the output hard to hallucinate into.
 */
export const templateExplainer: Explainer = {
  id: "template",
  async explain(req: ExplainRequest): Promise<string> {
    const lines: string[] = [ACTION_LEAD[req.action]];

    if (req.signals.length === 0) {
      lines.push(
        `${req.order.name} triggered no rules. Fraud score 0, address score 0.`,
      );
      return lines.join(" ");
    }

    lines.push(
      `${req.order.name}: fraud score ${req.fraud.score} (${req.fraud.band}), address score ${req.deliverability.score} (${req.deliverability.band}).`,
    );

    const byKind = (kind: RiskSignal["kind"]): RiskSignal[] =>
      req.signals.filter((s) => s.kind === kind).sort((a, b) => b.weight - a.weight);

    const fraudSignals = byKind("fraud");
    if (fraudSignals.length > 0) {
      lines.push(`Payment: ${fraudSignals.map((s) => s.detail).join(" ")}`);
    }
    const addressSignals = byKind("deliverability");
    if (addressSignals.length > 0) {
      lines.push(`Address: ${addressSignals.map((s) => s.detail).join(" ")}`);
    }
    return lines.join(" ");
  },
};

/** Minimal shape of the Anthropic Messages API response we rely on. */
interface MessagesResponse {
  content?: Array<{ type: string; text?: string }>;
}

export interface AnthropicExplainerOptions {
  apiKey: string;
  model?: string;
  /** Injected so the HTTP path is testable without a network or a global stub. */
  fetchImpl?: typeof fetch;
  /** Milliseconds before giving up and falling back to the template. */
  timeoutMs?: number;
}

const DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/**
 * Prompt construction, kept separate so a test can assert what is sent.
 *
 * It deliberately ships the signals as the only facts available and tells the
 * model not to add any. The scores are included as given, not as something to
 * re-derive, because the model re-deriving them is exactly the failure mode
 * this design rules out.
 */
export function buildPrompt(req: ExplainRequest): string {
  const facts = req.signals.length === 0
    ? "- none, the order triggered no rules"
    : req.signals
        .map((s) => `- [${s.kind}, weight ${s.weight}] ${s.detail}`)
        .join("\n");

  return [
    `Order ${req.order.name}, ${req.order.totalAmount.toFixed(2)} ${req.order.currency}, shipping to ${req.order.shippingAddress.countryCode.toUpperCase()}.`,
    `Decision already made by the rules engine: ${req.action}.`,
    `Fraud score ${req.fraud.score} of 100 (${req.fraud.band}). Address score ${req.deliverability.score} of 100 (${req.deliverability.band}).`,
    "",
    "Findings:",
    facts,
    "",
    "Write a note for the person who will review this order. Two or three sentences.",
    "Lead with what they should check first. Use only the findings above; do not",
    "introduce facts, do not guess at intent, and do not restate or recalculate",
    "the scores. Do not tell them whether to approve or cancel, that is their call.",
  ].join("\n");
}

/**
 * LLM-written note. Falls back to the template on any failure.
 *
 * Falling back rather than throwing is the right call because the note is a
 * convenience: a timeout on the Anthropic API should never stop an order
 * reaching the review queue. The assessment records which explainer actually
 * produced the text, so a silent fallback is still visible afterwards.
 */
export function anthropicExplainer(options: AnthropicExplainerOptions): Explainer {
  const model = options.model ?? DEFAULT_MODEL;
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    id: `anthropic:${model}`,
    async explain(req: ExplainRequest): Promise<string> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await doFetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": options.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: 300,
            messages: [{ role: "user", content: buildPrompt(req) }],
          }),
          signal: controller.signal,
        });
        if (!res.ok) return templateExplainer.explain(req);

        const body = (await res.json()) as MessagesResponse;
        const text = (body.content ?? [])
          .filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("")
          .trim();
        return text === "" ? templateExplainer.explain(req) : text;
      } catch {
        return templateExplainer.explain(req);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Pick an explainer from the environment. No key means the template. */
export function resolveExplainer(env: Record<string, string | undefined>): Explainer {
  const apiKey = env["ANTHROPIC_API_KEY"];
  if (apiKey === undefined || apiKey.trim() === "") return templateExplainer;
  const model = env["RISK_EXPLAINER_MODEL"];
  return anthropicExplainer(model === undefined ? { apiKey } : { apiKey, model });
}

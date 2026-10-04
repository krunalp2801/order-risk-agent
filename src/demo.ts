/**
 * End-to-end demo over the bundled fixtures.
 *
 * Run with `npm run demo`. No credentials, no network. With ANTHROPIC_API_KEY
 * set it uses the LLM for the reviewer notes and the scores stay the same,
 * which is the claim worth seeing for yourself.
 *
 * CI runs this as a smoke test, so it must exit non-zero if the pipeline
 * stops doing its job.
 */

import { assessAll } from "./assess.ts";
import { DEMO_ORDERS } from "./fixtures.ts";
import { resolveExplainer } from "./explain.ts";
import { thresholdsFromEnv } from "./score.ts";
import { ReviewQueue } from "./queue.ts";
import type { Action, Assessment } from "./types.ts";

const ACTION_LABEL: Record<Action, string> = {
  release: "release",
  review_fraud: "payment review",
  fix_address: "address fix",
  review_both: "payment + address",
};

const pad = (s: string, n: number): string => (s.length >= n ? s.slice(0, n) : s + " ".repeat(n - s.length));
const padLeft = (s: string, n: number): string => (s.length >= n ? s : " ".repeat(n - s.length) + s);

function table(assessments: Assessment[]): void {
  console.log(
    `${pad("order", 7)} ${padLeft("fraud", 6)} ${padLeft("addr", 5)}  ${pad("routed to", 18)} top signal`,
  );
  console.log("-".repeat(78));
  for (const a of assessments) {
    const top = [...a.signals].sort((x, y) => y.weight - x.weight)[0];
    console.log(
      `${pad(a.orderName, 7)} ${padLeft(String(a.fraud.score), 6)} ${padLeft(String(a.deliverability.score), 5)}  ` +
        `${pad(ACTION_LABEL[a.action], 18)} ${top === undefined ? "-" : top.rule}`,
    );
  }
}

async function main(): Promise<void> {
  const explainer = resolveExplainer(process.env);
  const thresholds = thresholdsFromEnv(process.env);

  console.log(`order-risk-agent demo`);
  console.log(`explainer: ${explainer.id}`);
  console.log(`thresholds: review at ${thresholds.review}, hold at ${thresholds.hold}`);
  console.log(`orders: ${DEMO_ORDERS.length}\n`);

  const assessments = await assessAll(DEMO_ORDERS, { explainer, thresholds });
  table(assessments);

  const queue = new ReviewQueue();
  for (const a of assessments) queue.enqueue(a);

  console.log(`\nreview queue, worst first`);
  console.log("-".repeat(78));
  for (const item of queue.pending()) {
    console.log(`${item.assessment.orderName}  priority ${item.priority}  ${ACTION_LABEL[item.assessment.action]}`);
    console.log(`  ${item.assessment.explanation}\n`);
  }

  // A reviewer works the queue. Approving a flagged order is a normal outcome:
  // a gift to another country is not fraud, it just needed a human to say so.
  const worst = queue.pending()[0];
  if (worst !== undefined) {
    queue.reject(worst.assessment.orderId, "fraud-team@example.com", "Card testing pattern, refunded.");
  }
  const gift = queue.get("gid://order/1005");
  if (gift !== undefined) {
    queue.approve(gift.assessment.orderId, "cs-team@example.com", "Customer confirmed by phone, shipping to family.");
  }

  const stats = queue.stats();
  console.log("-".repeat(78));
  console.log(
    `released without review: ${stats.released}   pending: ${stats.pending}   ` +
      `approved: ${stats.approved}   rejected: ${stats.rejected}`,
  );

  // Guard rails, so this file works as a CI smoke test rather than decoration.
  if (assessments.length !== DEMO_ORDERS.length) {
    throw new Error("assessment count does not match the order count");
  }
  if (stats.released < 1) {
    throw new Error("every fixture was flagged, so the rules are not discriminating");
  }
  if (stats.pending + stats.approved + stats.rejected < 1) {
    throw new Error("nothing was flagged, so the rules are not firing");
  }
  const noAction = assessments.find((a) => a.explanation.trim() === "");
  if (noAction !== undefined) {
    throw new Error(`no reviewer note written for ${noAction.orderName}`);
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});

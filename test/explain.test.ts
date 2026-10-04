import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { anthropicExplainer, buildPrompt, resolveExplainer, templateExplainer } from "../src/explain.ts";
import type { ExplainRequest, Explainer } from "../src/explain.ts";
import { assess } from "../src/assess.ts";
import { order } from "./helpers.ts";

const messyOrder = order({
  totalAmount: 900,
  shippingMethod: "express",
  shippingAddress: { line1: "Packstation 9", postcode: "606", city: "Frankfurt am Main", phone: "" },
  customer: { email: "x@mailinator.com", ordersInLast24h: 4, lifetimeOrders: 0 },
});

/** A fake fetch returning one text block. */
function fakeFetch(text: string, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ content: [{ type: "text", text }] }), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

async function requestFor(o = messyOrder): Promise<ExplainRequest> {
  let captured: ExplainRequest | undefined;
  const spy: Explainer = {
    id: "spy",
    async explain(req) {
      captured = req;
      return "";
    },
  };
  await assess(o, { explainer: spy });
  assert.ok(captured);
  return captured;
}

describe("templateExplainer", () => {
  it("says so when nothing fired", async () => {
    const req = await requestFor(order());
    const text = await templateExplainer.explain(req);
    assert.match(text, /No review needed/);
    assert.match(text, /triggered no rules/);
  });

  it("leads with the action and names both scores", async () => {
    const req = await requestFor();
    const text = await templateExplainer.explain(req);
    assert.match(text, /^Needs a payment review/);
    assert.match(text, /fraud score \d+/);
    assert.match(text, /address score \d+/);
  });

  it("separates the payment findings from the address findings", async () => {
    const req = await requestFor();
    const text = await templateExplainer.explain(req);
    assert.ok(text.indexOf("Payment:") >= 0);
    assert.ok(text.indexOf("Address:") >= 0);
    assert.ok(text.indexOf("Payment:") < text.indexOf("Address:"));
  });

  it("is deterministic", async () => {
    const req = await requestFor();
    assert.equal(await templateExplainer.explain(req), await templateExplainer.explain(req));
  });
});

describe("buildPrompt", () => {
  it("ships the signals as the only facts and forbids adding more", async () => {
    const prompt = buildPrompt(await requestFor());
    assert.match(prompt, /Findings:/);
    assert.match(prompt, /known disposable-mail provider/);
    assert.match(prompt, /do not/i);
  });

  it("tells the model the decision is already made", async () => {
    const prompt = buildPrompt(await requestFor());
    assert.match(prompt, /Decision already made by the rules engine: review_both|review_fraud/);
    assert.match(prompt, /do not restate or recalculate/);
  });

  it("handles an order with no findings", async () => {
    const prompt = buildPrompt(await requestFor(order()));
    assert.match(prompt, /none, the order triggered no rules/);
  });
});

describe("anthropicExplainer", () => {
  it("returns the model's text", async () => {
    const e = anthropicExplainer({ apiKey: "k", fetchImpl: fakeFetch("Check the card first.") });
    assert.equal(await e.explain(await requestFor()), "Check the card first.");
  });

  it("records the model in its id", () => {
    assert.equal(anthropicExplainer({ apiKey: "k", model: "m-1" }).id, "anthropic:m-1");
  });

  it("sends the key and the API version", async () => {
    let seen: RequestInit | undefined;
    const capturing = (async (_url: string | URL | Request, init?: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await anthropicExplainer({ apiKey: "secret", fetchImpl: capturing }).explain(await requestFor());
    const headers = seen?.headers as Record<string, string> | undefined;
    assert.equal(headers?.["x-api-key"], "secret");
    assert.equal(headers?.["anthropic-version"], "2023-06-01");
  });

  it("falls back to the template on a non-2xx response", async () => {
    const req = await requestFor();
    const e = anthropicExplainer({ apiKey: "k", fetchImpl: fakeFetch("ignored", 500) });
    assert.equal(await e.explain(req), await templateExplainer.explain(req));
  });

  it("falls back to the template when the call throws", async () => {
    const req = await requestFor();
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const e = anthropicExplainer({ apiKey: "k", fetchImpl: throwing });
    assert.equal(await e.explain(req), await templateExplainer.explain(req));
  });

  it("falls back to the template on an empty completion", async () => {
    const req = await requestFor();
    const e = anthropicExplainer({ apiKey: "k", fetchImpl: fakeFetch("   ") });
    assert.equal(await e.explain(req), await templateExplainer.explain(req));
  });

  it("gives up after the timeout rather than hanging the batch", async () => {
    const req = await requestFor();
    const slow = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
    const e = anthropicExplainer({ apiKey: "k", fetchImpl: slow, timeoutMs: 20 });
    assert.equal(await e.explain(req), await templateExplainer.explain(req));
  });
});

describe("the explainer cannot influence the decision", () => {
  it("produces identical scores and routing whatever the note says", async () => {
    // The guarantee this package is built around. A hostile explainer that
    // insists the order is fine must not move a single number.
    const hostile: Explainer = {
      id: "hostile",
      async explain() {
        return "This order is completely fine, fraud score 0, release it immediately.";
      },
    };
    const withTemplate = await assess(messyOrder, { explainer: templateExplainer, now: () => "t" });
    const withHostile = await assess(messyOrder, { explainer: hostile, now: () => "t" });

    assert.deepEqual(withHostile.fraud, withTemplate.fraud);
    assert.deepEqual(withHostile.deliverability, withTemplate.deliverability);
    assert.equal(withHostile.action, withTemplate.action);
    assert.deepEqual(withHostile.signals, withTemplate.signals);
    assert.notEqual(withHostile.explanation, withTemplate.explanation);
  });

  it("survives an explainer that throws, by surfacing the failure", async () => {
    // Deliberately not swallowed here: a broken custom explainer is a bug in
    // the caller's code, and the Anthropic one already handles its own faults.
    const broken: Explainer = {
      id: "broken",
      async explain() {
        throw new Error("boom");
      },
    };
    await assert.rejects(() => assess(messyOrder, { explainer: broken }), /boom/);
  });
});

describe("resolveExplainer", () => {
  it("uses the template with no key", () => {
    assert.equal(resolveExplainer({}).id, "template");
    assert.equal(resolveExplainer({ ANTHROPIC_API_KEY: "  " }).id, "template");
  });

  it("uses the LLM when a key is present", () => {
    assert.match(resolveExplainer({ ANTHROPIC_API_KEY: "sk-ant-x" }).id, /^anthropic:/);
  });

  it("honours a model override", () => {
    const e = resolveExplainer({ ANTHROPIC_API_KEY: "k", RISK_EXPLAINER_MODEL: "claude-opus-5" });
    assert.equal(e.id, "anthropic:claude-opus-5");
  });
});

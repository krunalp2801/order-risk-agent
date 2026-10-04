/**
 * Test helpers. An order builder, so each test states only the fields it
 * cares about and a reader can see the one thing under test instead of
 * forty lines of plausible address data.
 */

import type { Order } from "../src/types.ts";

export const baseOrder: Order = {
  id: "gid://order/test",
  name: "#test",
  createdAt: "2026-09-29T08:00:00Z",
  totalAmount: 50,
  currency: "EUR",
  lineItems: [{ sku: "SKU-1", title: "Thing", quantity: 1, unitPrice: 50 }],
  shippingAddress: {
    name: "Test Person",
    line1: "Teststrasse 1",
    postcode: "60311",
    city: "Frankfurt am Main",
    countryCode: "DE",
    phone: "+49 69 000000",
  },
  billingAddress: {
    name: "Test Person",
    line1: "Teststrasse 1",
    postcode: "60311",
    city: "Frankfurt am Main",
    countryCode: "DE",
  },
  shippingMethod: "standard",
  paymentMethod: "card",
  customer: {
    email: "test@example.de",
    ordersInLast24h: 1,
    lifetimeOrders: 5,
    chargebacks: 0,
    refundedOrders: 0,
  },
};

type OrderPatch = Omit<Partial<Order>, "shippingAddress" | "billingAddress" | "customer"> & {
  shippingAddress?: Partial<Order["shippingAddress"]>;
  billingAddress?: Partial<Order["billingAddress"]>;
  customer?: Partial<Order["customer"]>;
};

/** `baseOrder` with the given fields replaced. Addresses merge one level deep. */
export function order(patch: OrderPatch = {}): Order {
  const { shippingAddress, billingAddress, customer, ...rest } = patch;
  return {
    ...baseOrder,
    ...rest,
    shippingAddress: { ...baseOrder.shippingAddress, ...shippingAddress },
    billingAddress: { ...baseOrder.billingAddress, ...billingAddress },
    customer: { ...baseOrder.customer, ...customer },
  };
}

/** A fixed clock, so queued/decided timestamps are assertable. */
export function fixedClock(start = "2026-09-29T12:00:00.000Z"): () => string {
  let n = 0;
  return () => new Date(Date.parse(start) + n++ * 1000).toISOString();
}

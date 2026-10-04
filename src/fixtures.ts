/**
 * Demo orders.
 *
 * Deliberately untidy. A fixture set where everything is clean teaches you
 * nothing, and a fixture set where everything is fraud teaches you less. The
 * mix here is roughly what a real day looks like: most orders fine, a few
 * with bad address data typed by a human or mangled by a feed, and one or two
 * that genuinely want a second pair of eyes.
 *
 * Several of these are shapes I have actually had to fix by hand on live
 * orders: the postcode sitting in the city column, the street with no house
 * number, "Germany" arriving in a field typed as alpha-2.
 */

import type { Order } from "./types.ts";

const customer = (
  email: string,
  overrides: Partial<Order["customer"]> = {},
): Order["customer"] => ({
  email,
  ordersInLast24h: 1,
  lifetimeOrders: 3,
  chargebacks: 0,
  refundedOrders: 0,
  ...overrides,
});

export const DEMO_ORDERS: Order[] = [
  {
    // The common case: a repeat customer, nothing wrong. Scores zero.
    id: "gid://order/1001",
    name: "#1001",
    createdAt: "2026-09-29T08:12:00Z",
    totalAmount: 64.9,
    currency: "EUR",
    lineItems: [{ sku: "GG-LADDOO-500", title: "Besan Laddoo 500g", quantity: 2, unitPrice: 32.45 }],
    shippingAddress: {
      name: "Anja Weber",
      line1: "Gartenstrasse 14",
      postcode: "60594",
      city: "Frankfurt am Main",
      countryCode: "DE",
      phone: "+49 69 1234567",
    },
    billingAddress: {
      name: "Anja Weber",
      line1: "Gartenstrasse 14",
      postcode: "60594",
      city: "Frankfurt am Main",
      countryCode: "DE",
    },
    shippingMethod: "standard",
    paymentMethod: "paypal",
    customer: customer("anja.weber@example.de", { lifetimeOrders: 11 }),
  },
  {
    // Postcode landed in the city column. Honest customer, broken feed.
    // This is the case the two-score split exists for: zero fraud risk,
    // guaranteed failed label.
    id: "gid://order/1002",
    name: "#1002",
    createdAt: "2026-09-29T09:40:00Z",
    totalAmount: 41.0,
    currency: "EUR",
    lineItems: [{ sku: "GG-ROLI-100", title: "Roli Chawal set", quantity: 1, unitPrice: 41.0 }],
    shippingAddress: {
      name: "Thomas Bauer",
      line1: "Lindenallee 7",
      postcode: "Koeln",
      city: "50667",
      countryCode: "DE",
      phone: "+49 221 998877",
    },
    billingAddress: {
      name: "Thomas Bauer",
      line1: "Lindenallee 7",
      postcode: "50667",
      city: "Koeln",
      countryCode: "DE",
    },
    shippingMethod: "standard",
    paymentMethod: "card",
    customer: customer("t.bauer@example.de", { lifetimeOrders: 4 }),
  },
  {
    // No house number anywhere, and "Germany" in an alpha-2 field.
    // Two deliverability signals, no fraud signals.
    id: "gid://order/1003",
    name: "#1003",
    createdAt: "2026-09-29T10:05:00Z",
    totalAmount: 88.5,
    currency: "EUR",
    lineItems: [{ sku: "GG-GIFTBOX-M", title: "Festival gift box M", quantity: 1, unitPrice: 88.5 }],
    shippingAddress: {
      name: "Priya Shah",
      line1: "Hauptstrasse",
      line2: "bei Mueller",
      postcode: "10115",
      city: "Berlin",
      countryCode: "Germany",
    },
    billingAddress: {
      name: "Priya Shah",
      line1: "Hauptstrasse 22",
      postcode: "10115",
      city: "Berlin",
      countryCode: "DE",
    },
    shippingMethod: "standard",
    paymentMethod: "invoice",
    customer: customer("priya.shah@example.com", { lifetimeOrders: 2 }),
  },
  {
    // Card testing: burst of orders, throwaway address, new account, and a
    // postcode a bot did not bother to get right. Fraud and address both.
    id: "gid://order/1004",
    name: "#1004",
    createdAt: "2026-09-29T11:21:00Z",
    totalAmount: 212.0,
    currency: "EUR",
    lineItems: [{ sku: "GG-SILVER-COIN", title: "Silver coin 10g", quantity: 4, unitPrice: 53.0 }],
    shippingAddress: {
      name: "M Keller",
      line1: "Packstation 142",
      postcode: "8033",
      city: "Muenchen",
      countryCode: "DE",
    },
    billingAddress: {
      name: "M Keller",
      line1: "Packstation 142",
      postcode: "80331",
      city: "Muenchen",
      countryCode: "DE",
    },
    shippingMethod: "express",
    paymentMethod: "card",
    customer: customer("mk88@mailinator.com", { ordersInLast24h: 6, lifetimeOrders: 0 }),
  },
  {
    // Gift to another country on a first order. Looks bad, usually is not.
    // Lands in review rather than being refused, which is the whole argument.
    id: "gid://order/1005",
    name: "#1005",
    createdAt: "2026-09-29T12:02:00Z",
    totalAmount: 430.0,
    currency: "EUR",
    lineItems: [{ sku: "GG-HAMPER-XL", title: "Diwali hamper XL", quantity: 1, unitPrice: 430.0 }],
    shippingAddress: {
      name: "Rupal Desai",
      line1: "Nirvana Road 118",
      postcode: "380015",
      city: "Ahmedabad",
      countryCode: "IN",
      phone: "+91 79 40001234",
    },
    billingAddress: {
      name: "Rupal Desai",
      line1: "Schillerstrasse 3",
      postcode: "70173",
      city: "Stuttgart",
      countryCode: "DE",
    },
    shippingMethod: "standard",
    paymentMethod: "card",
    customer: customer("r.desai@example.com", { lifetimeOrders: 0 }),
  },
  {
    // Prior chargeback. One signal, reaches hold on its own, by design.
    id: "gid://order/1006",
    name: "#1006",
    createdAt: "2026-09-29T13:30:00Z",
    totalAmount: 59.0,
    currency: "EUR",
    lineItems: [{ sku: "GG-TEA-250", title: "Masala chai 250g", quantity: 2, unitPrice: 29.5 }],
    shippingAddress: {
      name: "Lars Hoffmann",
      line1: "Bremer Weg 9a",
      postcode: "28195",
      city: "Bremen",
      countryCode: "DE",
      phone: "+49 421 556677",
    },
    billingAddress: {
      name: "Lars Hoffmann",
      line1: "Bremer Weg 9a",
      postcode: "28195",
      city: "Bremen",
      countryCode: "DE",
    },
    shippingMethod: "standard",
    paymentMethod: "card",
    customer: customer("l.hoffmann@example.de", { lifetimeOrders: 7, chargebacks: 1, refundedOrders: 2 }),
  },
  {
    // Wholesale-looking quantity, same-day shipping, no phone number.
    // One fraud signal and one deliverability signal: review_both.
    id: "gid://order/1007",
    name: "#1007",
    createdAt: "2026-09-29T14:48:00Z",
    totalAmount: 288.0,
    currency: "EUR",
    lineItems: [
      { sku: "GG-LADDOO-500", title: "Besan Laddoo 500g", quantity: 12, unitPrice: 19.0 },
      { sku: "GG-ROLI-100", title: "Roli Chawal set", quantity: 2, unitPrice: 30.0 },
    ],
    shippingAddress: {
      name: "Shah Grocery",
      line1: "Kaiserstrasse 55",
      postcode: "60329",
      city: "Frankfurt am Main",
      countryCode: "DE",
    },
    billingAddress: {
      name: "Shah Grocery",
      line1: "Kaiserstrasse 55",
      postcode: "60329",
      city: "Frankfurt am Main",
      countryCode: "DE",
    },
    shippingMethod: "same_day",
    paymentMethod: "invoice",
    customer: customer("orders@shahgrocery.example", { lifetimeOrders: 23 }),
  },
  {
    // Malformed UK postcode, otherwise unremarkable.
    id: "gid://order/1008",
    name: "#1008",
    createdAt: "2026-09-29T15:19:00Z",
    totalAmount: 73.2,
    currency: "GBP",
    lineItems: [{ sku: "GG-GIFTBOX-S", title: "Festival gift box S", quantity: 1, unitPrice: 73.2 }],
    shippingAddress: {
      name: "Harpreet Singh",
      line1: "42 Mill Lane",
      postcode: "SW1A",
      city: "London",
      countryCode: "GB",
      phone: "+44 20 7000 1111",
    },
    billingAddress: {
      name: "Harpreet Singh",
      line1: "42 Mill Lane",
      postcode: "SW1A 1AA",
      city: "London",
      countryCode: "GB",
    },
    shippingMethod: "standard",
    paymentMethod: "card",
    customer: customer("h.singh@example.co.uk", { lifetimeOrders: 6 }),
  },
  {
    // High value, first order, express, locker. Several medium signals that
    // add up without any one of them being damning.
    id: "gid://order/1009",
    name: "#1009",
    createdAt: "2026-09-29T16:55:00Z",
    totalAmount: 1180.0,
    currency: "EUR",
    lineItems: [{ sku: "GG-SILVER-SET", title: "Silver pooja set", quantity: 1, unitPrice: 1180.0 }],
    shippingAddress: {
      name: "A Fischer",
      line1: "Postfiliale 503",
      postcode: "20095",
      city: "Hamburg",
      countryCode: "DE",
      phone: "+49 40 112233",
    },
    billingAddress: {
      name: "A Fischer",
      line1: "Elbchaussee 12",
      postcode: "22765",
      city: "Hamburg",
      countryCode: "DE",
    },
    shippingMethod: "express",
    paymentMethod: "sofort",
    customer: customer("a.fischer@example.de", { lifetimeOrders: 0 }),
  },
];

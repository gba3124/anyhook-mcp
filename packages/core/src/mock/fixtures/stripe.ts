/**
 * Stripe event fixtures. Each value is a realistic-shape Event object
 * with the `type` field matching the key.
 */
export const stripeFixtures: Record<string, unknown> = {
  "payment_intent.succeeded": {
    id: "evt_test_webhook",
    object: "event",
    api_version: "2024-04-10",
    created: 1700000000,
    data: {
      object: {
        id: "pi_test_123",
        object: "payment_intent",
        amount: 2000,
        amount_received: 2000,
        currency: "usd",
        status: "succeeded",
        latest_charge: "ch_test_123",
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: "payment_intent.succeeded",
  },

  "invoice.payment_failed": {
    id: "evt_test_webhook",
    object: "event",
    created: 1700000000,
    data: {
      object: {
        id: "in_test_123",
        object: "invoice",
        amount_due: 5000,
        currency: "usd",
        status: "open",
        attempt_count: 1,
        next_payment_attempt: 1700086400,
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: "invoice.payment_failed",
  },

  "customer.subscription.created": {
    id: "evt_test_webhook",
    object: "event",
    created: 1700000000,
    data: {
      object: {
        id: "sub_test_123",
        object: "subscription",
        customer: "cus_test_123",
        status: "active",
        items: {
          object: "list",
          data: [
            {
              id: "si_test_123",
              object: "subscription_item",
              price: { id: "price_test_123", unit_amount: 2000, currency: "usd" },
              quantity: 1,
            },
          ],
        },
      },
    },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type: "customer.subscription.created",
  },
};

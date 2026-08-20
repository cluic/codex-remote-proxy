import test from "node:test";
import assert from "node:assert/strict";

import { AccountRoutingStateSource } from "../src/worker/account-routing-state.mjs";

function state(overrides = {}) {
  return {
    authMode: "chatgpt",
    quotaStatus: "available",
    blockedUntil: null,
    updatedAt: "2026-08-20T00:00:00.000Z",
    ...overrides
  };
}

test("account routing state applies increasing revisions and returns clones", () => {
  const source = new AccountRoutingStateSource();
  const input = state();
  source.apply({ revision: 1, state: input });
  input.quotaStatus = "exhausted";
  assert.deepEqual(source.current(), { revision: 1, state: state() });

  const current = source.current();
  current.state.authMode = "apikey";
  assert.deepEqual(source.current(), { revision: 1, state: state() });

  assert.deepEqual(source.apply({
    revision: 2,
    state: state({ quotaStatus: "exhausted", blockedUntil: 1_787_200_000 })
  }), {
    revision: 2,
    state: state({ quotaStatus: "exhausted", blockedUntil: 1_787_200_000 })
  });
});

test("account routing state rejects invalid, stale, and conflicting revisions", () => {
  const source = new AccountRoutingStateSource();
  assert.throws(
    () => source.current(),
    (error) => error?.code === "ACCOUNT_ROUTING_STATE_UNAVAILABLE"
  );
  source.apply({ revision: 2, state: state() });
  assert.throws(
    () => source.apply({ revision: 1, state: state() }),
    (error) => error?.code === "STALE_ACCOUNT_ROUTING_STATE"
  );
  assert.throws(
    () => source.apply({ revision: 2, state: state({ quotaStatus: "unknown" }) }),
    (error) => error?.code === "STALE_ACCOUNT_ROUTING_STATE"
  );
  assert.deepEqual(
    source.apply({ revision: 2, state: state() }, { allowExisting: true }),
    { revision: 2, state: state() }
  );
  assert.throws(
    () => source.apply({ revision: 3, state: { ...state(), extra: true } }),
    (error) => error?.code === "ACCOUNT_ROUTING_STATE_INVALID"
  );
});

test("account routing state seeds newer snapshots and ignores older configuration snapshots", () => {
  const source = new AccountRoutingStateSource();
  source.seed({ revision: 2, state: state({ quotaStatus: "exhausted" }) });
  assert.deepEqual(
    source.seed({ revision: 1, state: state() }),
    { revision: 2, state: state({ quotaStatus: "exhausted" }) }
  );
  assert.deepEqual(
    source.seed({ revision: 3, state: state({ authMode: "apikey" }) }),
    { revision: 3, state: state({ authMode: "apikey" }) }
  );
});

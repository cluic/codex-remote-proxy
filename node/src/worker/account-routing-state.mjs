import { isDeepStrictEqual } from "node:util";

import { isValidAccountRoutingState } from "../routing/account-routing.mjs";

function stateError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

export class AccountRoutingStateSource {
  #revision = 0;
  #state = null;

  apply({ revision, state }, { allowExisting = false } = {}) {
    if (!Number.isSafeInteger(revision) || revision <= 0 || !isValidAccountRoutingState(state)) {
      throw stateError("ACCOUNT_ROUTING_STATE_INVALID");
    }
    if (revision < this.#revision
      || (revision === this.#revision
        && (!allowExisting || !isDeepStrictEqual(state, this.#state)))) {
      throw stateError("STALE_ACCOUNT_ROUTING_STATE");
    }
    if (revision > this.#revision) {
      this.#revision = revision;
      this.#state = structuredClone(state);
    }
    return this.current();
  }

  seed({ revision, state }) {
    if (!Number.isSafeInteger(revision) || revision <= 0 || !isValidAccountRoutingState(state)) {
      throw stateError("ACCOUNT_ROUTING_STATE_INVALID");
    }
    if (revision < this.#revision) return this.current();
    return this.apply({ revision, state }, { allowExisting: true });
  }

  current() {
    if (this.#state === null) {
      throw stateError("ACCOUNT_ROUTING_STATE_UNAVAILABLE");
    }
    return {
      revision: this.#revision,
      state: structuredClone(this.#state)
    };
  }
}

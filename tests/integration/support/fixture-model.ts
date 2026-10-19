import type { ModelPort, ModelRequest, ModelResponse } from '@knowscroll/backend/reasoning';
import { guardedModelPort } from '@knowscroll/backend/reasoning/nest-providers';

/**
 * CI fixture model: a labelled stand-in for a hosted model (real providers arrive in S2.2). It
 * counts the calls that actually reach it (after the transaction guard), so tests can prove the
 * attempt ledger never re-sends, and it is wrapped by the same guard as a real transport.
 */
export interface FixtureModel extends ModelPort {
  readonly calls: readonly ModelRequest[];
}

export function fixtureModel(
  respond: (request: ModelRequest) => Promise<ModelResponse> = (request) =>
    Promise.resolve({ remoteId: 'fixture-remote-1', output: `fixture:${request.purpose}` }),
): FixtureModel {
  const calls: ModelRequest[] = [];
  const port = guardedModelPort({
    provider: 'fixture',
    model: 'fixture-model-v0',
    async invoke(request) {
      calls.push(request);
      return respond(request);
    },
  });
  return {
    provider: port.provider,
    model: port.model,
    invoke: (request, signal) => port.invoke(request, signal),
    calls,
  };
}

/** A promise the test resolves by hand, to hold a fixture call in flight. */
export function gate<T = void>(): { readonly promise: Promise<T>; open(value: T): void } {
  let open!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

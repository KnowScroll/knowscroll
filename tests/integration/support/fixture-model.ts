import { guardedModelPort, type ModelPort, type ModelRequest, type ModelResponse } from '@knowscroll/backend/reasoning';

/**
 * CI fixture model: a labelled stand-in for a hosted model (real providers arrive in S2.2). It
 * counts calls so tests can prove the attempt ledger never re-sends, and it is wrapped by the same
 * transaction guard as a real transport.
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
  return { ...port, invoke: (request, signal) => port.invoke(request, signal), calls };
}

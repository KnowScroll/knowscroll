/** Builds one value from Nest-style factory providers without Nest (tests only). */
export interface FactoryProvider {
  readonly provide: symbol;
  readonly inject: readonly symbol[];
  readonly useFactory: (...dependencies: never[]) => unknown;
}

export function buildFromProviders(
  providers: readonly FactoryProvider[],
  token: symbol,
  values: ReadonlyMap<symbol, unknown>,
): unknown {
  const provider = providers.find((candidate) => candidate.provide === token);
  if (provider === undefined) throw new Error(`No provider for ${token.toString()}`);
  const dependencies = provider.inject.map((dependency) => {
    if (!values.has(dependency)) throw new Error(`No value for ${dependency.toString()}`);
    return values.get(dependency);
  });
  return (provider.useFactory as (...args: unknown[]) => unknown)(...dependencies);
}

/**
 * Builds one value from factory providers, building the providers it depends on first (a token that
 * is in `values` is used as it is). A missing provider, or a cycle, throws. Tests only.
 */
export function buildRecursively(
  providers: readonly FactoryProvider[],
  token: symbol,
  values: Map<symbol, unknown>,
  building: ReadonlySet<symbol> = new Set(),
): unknown {
  if (values.has(token)) return values.get(token);
  if (building.has(token)) throw new Error(`Provider cycle at ${token.toString()}`);
  const provider = providers.find((candidate) => candidate.provide === token);
  if (provider === undefined) throw new Error(`No provider for ${token.toString()}`);
  const next = new Set([...building, token]);
  for (const dependency of provider.inject) buildRecursively(providers, dependency, values, next);
  const value = buildFromProviders(providers, token, values);
  values.set(token, value);
  return value;
}

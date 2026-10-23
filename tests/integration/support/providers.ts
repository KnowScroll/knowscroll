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

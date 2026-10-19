import { z } from 'zod';

/**
 * Raised when process configuration is invalid. Problems name the variable and the kind of
 * problem only. Values are never echoed, because several variables (for example `DATABASE_URL`)
 * carry credentials.
 */
export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';
  constructor(readonly problems: readonly string[]) {
    super(`Invalid configuration: ${problems.join('; ')}`);
  }
}

export type Environment = Readonly<Record<string, string | undefined>>;

/** The result of checking some variables: the value, or every problem found. */
export type Checked<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Checks the named variables with `schema`. Each problem is `VARIABLE: kind_code`; it never
 * contains the input value.
 */
export function checkEnvironment<T extends z.ZodType>(
  schema: T,
  variables: Record<string, string | undefined>,
): Checked<z.infer<T>> {
  const result = schema.safeParse(variables);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    problems: result.error.issues.map(
      (issue) => `${issue.path.map(String).join('_') || 'ENVIRONMENT'}: ${problemKind(issue.code)}`,
    ),
  };
}

/**
 * Combines several checks so that one {@link ConfigurationError} reports every problem of every
 * part, not only the first part that failed.
 */
export function combineChecks<const T extends readonly Checked<unknown>[]>(
  ...parts: T
): { readonly [K in keyof T]: T[K] extends Checked<infer V> ? V : never } {
  const problems = parts.flatMap((part) => (part.ok ? [] : part.problems));
  if (problems.length > 0) throw new ConfigurationError(problems);
  return parts.map((part) => (part.ok ? part.value : undefined)) as {
    readonly [K in keyof T]: T[K] extends Checked<infer V> ? V : never;
  };
}

/** Problem kinds are codes, so a configuration problem can be logged without any free text. */
function problemKind(code: string): string {
  switch (code) {
    case 'invalid_type':
      return 'missing_or_wrong_type';
    case 'invalid_value':
      return 'not_allowed';
    case 'too_small':
    case 'too_big':
      return 'out_of_range';
    default:
      return 'invalid_format';
  }
}

/** `NODE_ENV`: `production` on the VPS; `test` in CI; `development` otherwise. */
export const NodeEnvSchema = z.enum(['production', 'test', 'development']);
export type NodeEnv = z.infer<typeof NodeEnvSchema>;

/** A world name such as `dev`, `stage`, `live`, `ci` or `local`. */
export const WorldSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, { message: 'must be a lowercase world name' });

/** A full lowercase commit SHA. */
export const CommitSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, { message: 'must be a 40-character lowercase commit SHA' });

/** A lowercase hex SHA-256. */
export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, { message: 'must be a 64-character lowercase SHA-256' });

/** A PostgreSQL connection URL (a credential: never logged). */
export const PostgresUrlSchema = z.string().refine((value) => /^postgres(ql)?:\/\//.test(value), {
  message: 'must be a postgres:// or postgresql:// URL',
});

/** A TCP port number. */
export const PortSchema = z.coerce.number().int().min(1).max(65_535);

/** An optional integer variable between 1 and `max`, with a default. */
export function positiveInteger(defaultValue: number, max: number) {
  return z.coerce.number().int().min(1).max(max).default(defaultValue);
}

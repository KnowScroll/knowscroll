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

/**
 * Parses the named variables with `schema` and throws one {@link ConfigurationError} that lists
 * every problem. Issue messages come from our own schemas and never contain the input value.
 */
export function parseEnvironment<T extends z.ZodType>(
  schema: T,
  variables: Record<string, string | undefined>,
): z.infer<T> {
  const result = schema.safeParse(variables);
  if (result.success) return result.data;
  const problems = result.error.issues.map((issue) => {
    const variable = issue.path.map(String).join('.') || '(environment)';
    const kind =
      issue.code === 'invalid_type'
        ? 'missing or wrong type'
        : issue.code === 'invalid_value'
          ? 'not an allowed value'
          : issue.message;
    return `${variable}: ${kind}`;
  });
  throw new ConfigurationError(problems);
}

export const NodeEnvSchema = z.enum(['production', 'test', 'development']);
export type NodeEnv = z.infer<typeof NodeEnvSchema>;

/** A world name such as `dev`, `stage`, `live`, `ci` or `local`. */
export const WorldSchema = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, { message: 'must be a lowercase world name' });

export const CommitSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/, { message: 'must be a 40-character lowercase commit SHA' });

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, { message: 'must be a 64-character lowercase SHA-256' });

export const PostgresUrlSchema = z.string().refine((value) => /^postgres(ql)?:\/\//.test(value), {
  message: 'must be a postgres:// or postgresql:// URL',
});

export const PortSchema = z.coerce.number().int().min(1).max(65_535);

export function positiveInteger(defaultValue: number, max: number) {
  return z.coerce.number().int().min(1).max(max).default(defaultValue);
}

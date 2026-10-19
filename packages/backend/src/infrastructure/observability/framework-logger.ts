import type { LogEvent } from './log-event.js';

/**
 * Framework lifecycle messages we recognise, reduced to a code plus structured fields. Nothing
 * else a framework says is written: free text is how request or user content would reach the
 * journal, so unrecognised messages become `unrecognised_message` with their context only.
 */
const recognised: readonly { readonly pattern: RegExp; readonly code: string }[] = [
  { pattern: /^Starting Nest application\.\.\.$/, code: 'starting' },
  { pattern: /^Nest application successfully started$/, code: 'started' },
  { pattern: /^[A-Za-z0-9_]{1,64} dependencies initialized$/, code: 'module_initialized' },
  { pattern: /^[A-Za-z0-9_]{1,64} \{[^}]{0,200}\}:$/, code: 'controller_mapped' },
  { pattern: /^[A-Za-z0-9_]{1,64} subscribed to the "[a-z_]{1,64}" message$/, code: 'gateway_subscription' },
];

const routeMapped = /^Mapped \{(\/[A-Za-z0-9/_:.{}*-]{0,199}), (GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS)\} route$/;

/**
 * Adapts framework diagnostics (Nest's LoggerService shape) to `logEvent`, so the framework
 * cannot write its own lines. Recognised lifecycle messages become codes and structured fields;
 * all other text, including every error message, is dropped; errors are reduced to class, code
 * and frames by the `error` field. Structurally compatible with Nest's `LoggerService`; no Nest
 * import, so this file stays framework-free.
 */
export class FrameworkLogAdapter {
  constructor(private readonly logEvent: LogEvent) {}

  log(message: unknown, ...rest: unknown[]): void {
    this.write('info', message, rest);
  }

  error(message: unknown, ...rest: unknown[]): void {
    this.write('error', message, rest);
  }

  warn(message: unknown, ...rest: unknown[]): void {
    this.write('warn', message, rest);
  }

  debug(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }

  verbose(message: unknown, ...rest: unknown[]): void {
    this.write('debug', message, rest);
  }

  fatal(message: unknown, ...rest: unknown[]): void {
    this.write('fatal', message, rest);
  }

  private write(
    severity: 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: unknown,
    rest: readonly unknown[],
  ): void {
    // Nest passes the context name as the last string argument and, for errors, a stack string.
    const context =
      rest.length > 0 && typeof rest[rest.length - 1] === 'string' ? (rest[rest.length - 1] as string) : undefined;
    const error = message instanceof Error ? message : rest.find((item): item is Error => item instanceof Error);
    this.logEvent('framework.message', {
      severity,
      ...(context === undefined ? {} : { context }),
      ...classify(message),
      ...(error === undefined ? {} : { error }),
    });
  }
}

function classify(message: unknown): { reasonCode: string; route?: string; method?: string } {
  if (typeof message !== 'string') return { reasonCode: message instanceof Error ? 'error' : 'unrecognised_message' };
  const mapped = routeMapped.exec(message);
  if (mapped?.[1] !== undefined && mapped[2] !== undefined)
    return { reasonCode: 'route_mapped', route: mapped[1], method: mapped[2] };
  return { reasonCode: recognised.find((entry) => entry.pattern.test(message))?.code ?? 'unrecognised_message' };
}

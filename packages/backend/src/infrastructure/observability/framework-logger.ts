import type { LogEvent } from './log-event.js';

/**
 * Adapts framework diagnostics (Nest's LoggerService shape) to `logEvent`, so the framework
 * cannot write its own lines. Informational messages are scrubbed and length-limited; error
 * messages are dropped and errors are reduced to class, code and frames by the `error` field. Structurally compatible with Nest's `LoggerService`; no Nest
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
    // Error-level framework messages are usually an exception's message, which can carry
    // driver or provider text (SQL values, URLs); only lower severities keep their scrubbed text.
    const keepMessage = typeof message === 'string' && severity !== 'error' && severity !== 'fatal';
    this.logEvent('framework.message', {
      severity,
      ...(context === undefined ? {} : { context }),
      ...(keepMessage ? { message } : {}),
      ...(error === undefined ? {} : { error }),
    });
  }
}

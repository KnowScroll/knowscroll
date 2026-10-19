import type { LogEvent } from '../observability/index.js';

/** A started process: `stop` stops admission, drains bounded work and closes resources. */
export interface RunningProcess {
  stop(): Promise<void>;
}

export interface ProcessLifecycleOptions {
  readonly logEvent: LogEvent;
  /** Longest a graceful stop (or a start interrupted by a signal) may take before exit 1. */
  readonly shutdownGraceMs: number;
  /** Starts everything; resolves once the process is serving or consuming. */
  readonly start: () => Promise<RunningProcess>;
}

/**
 * Runs a long-lived process: start once, stop once on SIGTERM or SIGINT, and exit with status 0
 * after a clean stop or 1 when start or stop fails or exceeds the grace period. Unhandled
 * rejections and uncaught exceptions are logged sanitised (`process.crashed`) and exit 1.
 *
 * Signal handlers are installed before anything starts. The first signal arms the grace
 * deadline at once, so a start that hangs (for example on an unreachable database) still ends
 * within the grace period; a signal that arrives while starting is honoured as soon as start
 * completes (never the default kill). Exit codes are a contract with systemd and CI: 0 means
 * drained and closed cleanly.
 */
export async function runProcess(options: ProcessLifecycleOptions): Promise<void> {
  const { logEvent } = options;
  process.on('unhandledRejection', (error) => {
    logEvent('process.crashed', { reasonCode: 'unhandled_rejection', error });
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    logEvent('process.crashed', { reasonCode: 'uncaught_exception', error });
    process.exit(1);
  });

  let running: RunningProcess | undefined;
  let signalled: { readonly signal: NodeJS.Signals; readonly at: number } | undefined;
  let stopping = false;

  const stop = (current: RunningProcess, signal: { readonly at: number }): void => {
    if (stopping) return;
    stopping = true;
    current.stop().then(
      () => {
        logEvent('process.stopped', { outcome: 'clean', durationMs: Date.now() - signal.at });
        process.exit(0);
      },
      (error: unknown) => {
        logEvent('process.stop_failed', { reasonCode: 'stop_failed', error });
        process.exit(1);
      },
    );
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    if (signalled !== undefined) return;
    signalled = { signal, at: Date.now() };
    logEvent('process.stopping', { signal });
    const deadline = setTimeout(() => {
      logEvent('process.stop_failed', {
        reasonCode: running === undefined ? 'start_interrupted' : 'shutdown_grace_exceeded',
      });
      process.exit(1);
    }, options.shutdownGraceMs);
    deadline.unref();
    if (running !== undefined) stop(running, signalled);
  };
  process.on('SIGTERM', onSignal);
  process.on('SIGINT', onSignal);

  try {
    running = await options.start();
  } catch (error) {
    logEvent('process.start_failed', { reasonCode: 'start_failed', error });
    process.exit(1);
  }
  logEvent('process.started', { pid: process.pid, nodeVersion: process.version });
  if (signalled !== undefined) stop(running, signalled);
}

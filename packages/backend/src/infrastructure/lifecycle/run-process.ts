import type { LogEvent } from '../observability/index.js';

/** A started process: `stop` stops admission, drains bounded work and closes resources. */
export interface RunningProcess {
  stop(): Promise<void>;
}

export interface ProcessLifecycleOptions {
  readonly logEvent: LogEvent;
  /** Longest a graceful stop may take before the process exits with failure. */
  readonly shutdownGraceMs: number;
  /** Starts everything; resolves once the process is serving or consuming. */
  readonly start: () => Promise<RunningProcess>;
}

/**
 * Runs a long-lived process: start once, stop once on SIGTERM or SIGINT, and exit with status 0
 * after a clean stop or 1 when start or stop fails or exceeds the grace period. Unhandled
 * rejections and uncaught exceptions are logged sanitised and end the process with status 1.
 *
 * Signal handlers are installed before anything starts, so a signal that arrives while the
 * process is still starting is honoured as soon as start completes (never the default kill).
 * Exit codes are a contract with systemd and CI: 0 means drained and closed cleanly.
 */
export async function runProcess(options: ProcessLifecycleOptions): Promise<void> {
  const { logEvent } = options;
  const startedAt = Date.now();
  process.on('unhandledRejection', (error) => {
    logEvent('process.stop_failed', { reasonCode: 'unhandled_rejection', error });
    process.exit(1);
  });
  process.on('uncaughtException', (error) => {
    logEvent('process.stop_failed', { reasonCode: 'uncaught_exception', error });
    process.exit(1);
  });

  let running: RunningProcess | undefined;
  let requested: NodeJS.Signals | undefined;
  let stopping = false;

  const stop = (signal: NodeJS.Signals, current: RunningProcess): void => {
    if (stopping) return;
    stopping = true;
    logEvent('process.stopping', { signal });
    const deadline = setTimeout(() => {
      logEvent('process.stop_failed', { reasonCode: 'shutdown_grace_exceeded' });
      process.exit(1);
    }, options.shutdownGraceMs);
    deadline.unref();
    current.stop().then(
      () => {
        clearTimeout(deadline);
        logEvent('process.stopped', { outcome: 'clean', durationMs: Date.now() - startedAt });
        process.exit(0);
      },
      (error: unknown) => {
        clearTimeout(deadline);
        logEvent('process.stop_failed', { reasonCode: 'stop_failed', error });
        process.exit(1);
      },
    );
  };
  const onSignal = (signal: NodeJS.Signals): void => {
    if (running === undefined) requested ??= signal;
    else stop(signal, running);
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
  if (requested !== undefined) stop(requested, running);
}

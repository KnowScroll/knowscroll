import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';

/**
 * Starts and observes built release processes (`node dist/…`) for the release tests. Output
 * lines must all be diagnostic JSON records: anything else fails the test, because `logEvent`
 * is the only permitted logging path.
 */
export interface DiagnosticRecord {
  readonly event: string;
  readonly level: string;
  readonly [field: string]: unknown;
}

export interface ReleaseProcess {
  readonly records: readonly DiagnosticRecord[];
  readonly rawOutput: () => string;
  waitForEvent(event: string, timeoutMs?: number): Promise<DiagnosticRecord>;
  /** Sends `signal` and resolves with the exit code (null when killed by a signal). */
  stop(signal?: NodeJS.Signals, timeoutMs?: number): Promise<number | null>;
  /** Resolves with the exit code when the process ends by itself. */
  exited(timeoutMs?: number): Promise<number | null>;
}

/** The directory holding the deployed `api/` and `worker/` trees (`pnpm deploy` output). */
export function releaseDirectory(): string {
  const directory = process.env['KS_RELEASE_DIR'];
  if (directory === undefined || directory === '')
    throw new Error('KS_RELEASE_DIR must point at the deployed release (api/, worker/)');
  return directory;
}

export function startReleaseProcess(
  app: 'api' | 'worker',
  entry: 'main' | 'migrate',
  env: Record<string, string>,
): ReleaseProcess {
  const cwd = join(releaseDirectory(), app);
  const child: ChildProcess = spawn(process.execPath, [join('dist', `${entry}.js`)], {
    cwd,
    // A clean environment: only what the test passes, plus PATH for the runtime.
    env: { PATH: process.env['PATH'] ?? '', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const records: DiagnosticRecord[] = [];
  const nonRecords: string[] = [];
  let raw = '';
  const waiters: { event: string; resolve: (record: DiagnosticRecord) => void }[] = [];
  const onLine = (line: string): void => {
    if (line.trim() === '') return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      nonRecords.push(line);
      return;
    }
    const record = parsed as DiagnosticRecord;
    if (typeof record.event !== 'string' || record['schemaVersion'] !== 'diagnostic.v1') {
      nonRecords.push(line);
      return;
    }
    records.push(record);
    for (const waiter of waiters.filter((candidate) => candidate.event === record.event)) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(record);
    }
  };
  let buffer = '';
  const onData = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    raw += text;
    buffer += text;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) onLine(line);
  };
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  const exit = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => {
      if (buffer !== '') onLine(buffer);
      resolve(code);
    });
  });
  const withTimeout = <T>(promise: Promise<T>, timeoutMs: number, what: string): Promise<T> =>
    Promise.race([
      promise,
      new Promise<T>((_, reject) =>
        setTimeout(
          () => reject(new Error(`${app}/${entry}: timed out waiting for ${what}\n${raw}`)),
          timeoutMs,
        ).unref(),
      ),
    ]);
  return {
    records,
    rawOutput: () => raw,
    waitForEvent(event, timeoutMs = 20_000) {
      const existing = records.find((record) => record.event === event);
      if (existing !== undefined) return Promise.resolve(existing);
      return withTimeout(
        new Promise<DiagnosticRecord>((resolve) => waiters.push({ event, resolve })),
        timeoutMs,
        event,
      );
    },
    async stop(signal = 'SIGTERM', timeoutMs = 30_000) {
      if (child.exitCode === null && child.signalCode === null) child.kill(signal);
      const code = await withTimeout(exit, timeoutMs, 'exit');
      assertOnlyRecords(nonRecords, app);
      return code;
    },
    async exited(timeoutMs = 30_000) {
      const code = await withTimeout(exit, timeoutMs, 'exit');
      assertOnlyRecords(nonRecords, app);
      return code;
    },
  };
}

function assertOnlyRecords(nonRecords: readonly string[], app: string): void {
  if (nonRecords.length > 0)
    throw new Error(`${app} wrote ${nonRecords.length} line(s) that are not diagnostic records`);
}

/** A free TCP port on the loopback interface. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address === null || typeof address === 'string') reject(new Error('no port'));
        else resolve(address.port);
      });
    });
  });
}

/** Polls `url` until it answers (any status) or the deadline passes. */
export async function waitForHttp(url: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(url);
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

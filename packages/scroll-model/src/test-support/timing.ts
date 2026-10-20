/**
 * Wall-clock bounds in tests that guard against accidentally expensive work (a hostile input must
 * be refused cheaply). A shared CI runner only ever adds time (a garbage collection, a busy core),
 * so the cost of the work itself is the fastest of a few runs: the bound stays as tight as before
 * and a single slow run no longer fails a test that was right.
 */
export function fastestMs(run: () => unknown, times = 5): number {
  let best = Number.POSITIVE_INFINITY;
  for (let index = 0; index < times; index += 1) {
    const started = performance.now();
    run();
    best = Math.min(best, performance.now() - started);
  }
  return best;
}

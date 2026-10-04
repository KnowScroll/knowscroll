/** Registers `handler` for SIGINT then SIGTERM. Call order is registration order, so an entrypoint
 * that registers two handlers sees them run in the order it registered them. */
export function onStopSignal(handler: () => void): void {
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.on(signal, handler);
}

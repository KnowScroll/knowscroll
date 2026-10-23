/** A command ID (UUID v4), minted once per user intent and reused on its retries (blueprint §19). */
export function newCommandId(): string {
  return crypto.randomUUID();
}

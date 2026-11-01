/**
 * The rows of Watch together (migration 0094, D-256) as the use cases read them. The store that reads and writes them is `WatchStore`
 * in `ports.ts`, with the room's other stores. No row holds a playback position, and none can: the tables have no such column.
 */

export interface WatchSessionRow {
  readonly sessionId: string;
  /** The library Reel and the revision that was current when the session began. */
  readonly assetId: string;
  readonly assetRevision: number;
  /** The Reel's title, a public fact of that revision. */
  readonly title: string;
  /** The Reel's length, frozen from the library read at the start, so the session's end never waits on Content. */
  readonly durationMs: number;
  /** The member who shared it; none once they left, were removed, cleared their data or deleted their account. */
  readonly startedBy: string | null;
  /** When the first frame is due on the server's clock. */
  readonly startsAt: Date;
  /** When it ended or was stopped; none while it is on. */
  readonly stoppedAt: Date | null;
}

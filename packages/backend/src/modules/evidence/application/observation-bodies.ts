import {
  ReelPlaybackPayloadSchema,
  ActiveDwellPayloadSchema,
  BlockCoveragePayloadSchema,
  BlockInteractionPayloadSchema,
} from '@knowscroll/contracts';
import type { ObservationBody } from '../domain/reading-summary.js';

/**
 * Reads a stored observation's bounded payload back into the domain's body, validated on read (the
 * stored JSON is parsed by the same schemas the wire used, never cast). `undefined` for an unknown
 * kind or a payload that no longer parses: such an observation contributes nothing and is counted
 * by the caller.
 */
export function observationBody(kind: string, payload: unknown): ObservationBody | undefined {
  switch (kind) {
    case 'reel.playback': {
      const parsed = ReelPlaybackPayloadSchema.safeParse(payload);
      return parsed.success ? { kind, samples: parsed.data.samples } : undefined;
    }
    case 'scroll.block_coverage': {
      const parsed = BlockCoveragePayloadSchema.safeParse(payload);
      return parsed.success ? { kind, blocks: parsed.data.blocks } : undefined;
    }
    case 'scroll.active_dwell': {
      const parsed = ActiveDwellPayloadSchema.safeParse(payload);
      return parsed.success ? { kind, activeIntervalsMs: parsed.data.activeIntervalsMs } : undefined;
    }
    case 'scroll.block_interaction': {
      const parsed = BlockInteractionPayloadSchema.safeParse(payload);
      return parsed.success
        ? { kind, blockId: parsed.data.blockId, interaction: parsed.data.kind, atMs: parsed.data.atMs }
        : undefined;
    }
    default:
      return undefined;
  }
}

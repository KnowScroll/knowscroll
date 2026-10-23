/**
 * How a person came to an encounter. `direct` is an address (the `/scroll/<assetId>` route, a
 * resumed or typed link). The blueprint's other modes (vertical discovery, continuation, return,
 * format switch, explicit topic) arrive with the Composer and navigation; the database checks only
 * the shape of the value, so adding one needs no migration, only a code change here.
 */
export const EXPOSURE_ORIGINS = ['direct', 'composer'] as const;

export type ExposureOrigin = (typeof EXPOSURE_ORIGINS)[number];

/** What an exposure presents. Only Scrolls are opened by this story; Reels arrive with the player. */
export type ExposureKind = 'reel' | 'scroll';

/** An exposure as the application reads it back. */
export interface Exposure {
  readonly id: string;
  readonly assetId: string;
  readonly assetRevision: number;
  readonly kind: ExposureKind;
  readonly origin: string;
  readonly openedAt: Date;
  /** Undefined until the article became the active reading surface. */
  readonly activatedAt: Date | undefined;
  readonly privacyEpoch: number;
}

/**
 * What activating an exposure does: an exposure that is not active yet becomes active now; one that
 * already is keeps its original activation time (activation is idempotent and never moves).
 */
export function decideActivation(
  exposure: Pick<Exposure, 'activatedAt'>,
  now: Date,
): { readonly changed: boolean; readonly activatedAt: Date } {
  return exposure.activatedAt === undefined
    ? { changed: true, activatedAt: now }
    : { changed: false, activatedAt: exposure.activatedAt };
}

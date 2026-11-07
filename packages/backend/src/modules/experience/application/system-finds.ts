import { ReadSystemFindsSchema, SYSTEM_FINDS_LIMIT, SystemFindsSchema, type SystemFinds } from '@knowscroll/contracts';
import type { LibraryFindSource, ReadLibraryFinds } from '../../content/public.js';
import type { ReadOwnSystemTopic } from '../../geography/public.js';
import type { PersonalAuthority, PersonalScopeTx, WithPersonalScope } from '../../identity/public.js';

export interface SystemFindsPorts {
  /** Experience's fenced personal scope: an inactive owner is refused. */
  readonly withPersonalScope: WithPersonalScope;
  readonly readSystemTopic: ReadOwnSystemTopic;
  readonly readFinds: ReadLibraryFinds;
  /** Hidden and "not interested" assets of the caller, among these ids. */
  readonly readWithheld: (scope: PersonalScopeTx, assetIds: readonly string[]) => Promise<readonly string[]>;
}

export type SystemFindsResult =
  | { readonly kind: 'read'; readonly finds: SystemFinds }
  | { readonly kind: 'refused'; readonly code: 'INVALID_REQUEST' | 'UNIVERSE_UNAVAILABLE' };

/** How many of the system's newest Reels, and of its Scrolls, one read looks through before it picks. */
const LOOK = 24;

/**
 * A system's Reels and Scrolls (#697): what the person can open from a system, with or without a planet yet.
 *
 * Authority: the caller's current personal scope, entered twice. The first entry confirms the system is one of their own
 * factual systems and names its catalogue topic. The shared library is then read outside any transaction. The second entry
 * rechecks the system against the map after that wait and leaves out what the caller hid or set aside. Side effects: none;
 * no exposure, offer, evidence, demand or job. A find opens through its own address, where the real encounter starts.
 *
 * Each format is read on its own, so a system that has Reels never shows "No Reels" because more Scrolls were made lately,
 * and a Reel is listed only when it can be opened (a Reel document of positive length, not a fixture). Up to half the rows
 * go to each format, then the rest fill in. A library or row that cannot be read answers `temporarily_unavailable`.
 * Retry: safe; the read is simply made again.
 */
export function makeReadSystemFinds(p: SystemFindsPorts) {
  return async (authority: PersonalAuthority, input: unknown): Promise<SystemFindsResult> => {
    const parsed = ReadSystemFindsSchema.safeParse(input);
    if (!parsed.success) return { kind: 'refused', code: 'INVALID_REQUEST' };
    const q = parsed.data;
    const first = await p.withPersonalScope(authority, (scope) => p.readSystemTopic(scope, q.systemId));
    if (first.kind !== 'entered' || first.value.kind === 'refused')
      return { kind: 'refused', code: 'UNIVERSE_UNAVAILABLE' };
    const topic = first.value;
    let sources: readonly LibraryFindSource[] | undefined = [];
    if (topic.kind === 'read')
      try {
        const of = { kind: 'system', id: topic.topicId } as const;
        const [reels, scrolls] = await Promise.all([
          p.readFinds(of, LOOK, undefined, undefined, 'reel'),
          p.readFinds(of, LOOK, undefined, undefined, 'scroll'),
        ]);
        sources = [...reels, ...scrolls];
      } catch {
        // The shared library could not be read: said as a gap a retry can close, never as an empty system.
        sources = undefined;
      }
    const second = await p.withPersonalScope(authority, async (scope): Promise<SystemFinds | undefined> => {
      const live = await p.readSystemTopic(scope, q.systemId);
      if (live.kind === 'refused') return undefined;
      const common = {
        version: 'universe-system-finds.v1' as const,
        readId: q.readId,
        universeId: scope.authority.universeId,
        privacyEpoch: scope.authority.privacyEpoch,
        personalWatermark: scope.revisionAtEntry,
        systemId: q.systemId,
      };
      if (live.kind === 'unavailable')
        return SystemFindsSchema.parse({ ...common, status: 'unavailable', reason: live.reason });
      const gap = () =>
        SystemFindsSchema.parse({ ...common, status: 'unavailable', reason: 'temporarily_unavailable' });
      // The system's topic changed while the library was read: the rows belong to another topic, so read again later.
      if (topic.kind !== 'read' || live.topicId !== topic.topicId || sources === undefined) return gap();
      const read = sources;
      const withheld = new Set(
        await p.readWithheld(
          scope,
          read.map((source) => source.assetId),
        ),
      );
      const shown = pickBothFormats(read.filter((source) => !withheld.has(source.assetId)));
      const answer = SystemFindsSchema.safeParse({
        ...common,
        status: 'ready',
        finds: shown.map(({ assetId, assetRevision, kind, title }) => ({
          assetId,
          assetRevision,
          kind,
          title: title.slice(0, 240),
        })),
      });
      return answer.success ? answer.data : gap();
    });
    return second.kind === 'entered' && second.value
      ? { kind: 'read', finds: second.value }
      : { kind: 'refused', code: 'UNIVERSE_UNAVAILABLE' };
  };
}

/** Up to half the rows for each format, then the rest fill in, each format kept newest first. Pure. */
export function pickBothFormats(sources: readonly LibraryFindSource[]): readonly LibraryFindSource[] {
  const half = Math.floor(SYSTEM_FINDS_LIMIT / 2);
  const kept = new Set<LibraryFindSource>();
  for (const kind of ['reel', 'scroll'] as const)
    for (const source of sources.filter((s) => s.kind === kind && s.title.length > 0).slice(0, half)) kept.add(source);
  for (const source of sources) {
    if (kept.size >= SYSTEM_FINDS_LIMIT) break;
    if (source.title.length > 0) kept.add(source);
  }
  return sources.filter((source) => kept.has(source));
}

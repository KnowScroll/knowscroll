import { ClientCapabilities, type NavigateExperienceRequest, type NavigationOutcome } from '@knowscroll/contracts';
import {
  assembleSnapshot,
  bufferIsServable,
  evidenceQueryFor,
  readVerticalCandidates,
  renderableFormats,
  validAssessments,
  type ComposerSnapshot,
  type PreparedBuffer,
  type SemanticAssessments,
} from '../../composer/public.js';
import type {
  ContinuityLink,
  EncounterRef,
  EncounterSnapshot,
  RegionEncounterCandidate,
} from '../../content/public.js';
import type { GeographyRegionConstraint } from '../../geography/public.js';
import type { PersonalScopeTx } from '../../identity/public.js';
import { originalRecordingGeneration, type CommandKey } from './ports.js';
import type {
  ComposerSession,
  NavigationCommand,
  NavigationPorts,
  NavigationResult,
  StoredOffer,
} from './navigation-ports.js';
import { receipt } from './navigation-receipt.js';
import { commandRegion, isRegionOpen, json, ref, refuse, same } from './navigation-support.js';

type Intent = NavigateExperienceRequest['intent'];
type ExhaustedReason = Extract<NavigationOutcome, { status: 'exhausted' }>['reason'];
type CommandRegion = Extract<Awaited<ReturnType<typeof commandRegion>>, { kind: 'region' | 'none' }>;

/** How the offers will be chosen: ranked now from `snapshot`, or already ranked by the worker. */
export type Ranking =
  | { readonly kind: 'rank'; readonly snapshot: ComposerSnapshot }
  | { readonly kind: 'buffered'; readonly buffer: PreparedBuffer };

/** Everything the committing transaction needs from the preparing one. */
export interface Prepared {
  readonly kind: 'prepared';
  readonly recordingGeneration?: number;
  readonly session: ComposerSession;
  readonly creates: boolean;
  readonly source?: { readonly offerId: string; readonly exposureId: string };
  readonly mode: StoredOffer['mode'];
  readonly links: readonly ContinuityLink[];
  readonly ranking: Ranking;
  readonly reason: ExhaustedReason;
  readonly decisionId: string;
  readonly now: Date;
  readonly region?: {
    readonly constraint: GeographyRegionConstraint;
    readonly candidates: readonly RegionEncounterCandidate[];
    readonly hasMore: boolean;
  };
}

/** The session, capabilities and (for a move) source content a command starts from. */
interface Start {
  readonly kind: 'started';
  readonly session: ComposerSession;
  readonly creates: boolean;
  readonly existing?: ComposerSession;
  readonly capabilities: unknown;
  readonly formats: readonly ('reel' | 'scroll')[];
  readonly mode: StoredOffer['mode'];
  readonly now: Date;
  readonly source?: { readonly offerId: string; readonly exposureId: string };
  readonly sourceContent?: EncounterSnapshot;
}

/** What a mode's retrieval found, before ranking. */
interface Retrieved {
  readonly kind: 'retrieved';
  readonly candidates: readonly EncounterSnapshot[];
  readonly links: readonly ContinuityLink[];
  readonly exact?: EncounterRef;
  readonly reason: ExhaustedReason;
  readonly regionCandidates: readonly RegionEncounterCandidate[];
  readonly regionHasMore: boolean;
}

/**
 * Transaction 1 of a navigation (blueprint §7): read an authorised snapshot, or return a prior
 * receipt. It makes no lasting intent change. When a valid worker-prepared buffer exists for this
 * exact move it is used instead of retrieving and ranking again.
 */
export async function prepare(
  p: NavigationPorts,
  scope: PersonalScopeTx,
  command: NavigationCommand,
  key: CommandKey,
): Promise<Prepared | NavigationResult> {
  const region = await commandRegion(p, scope, command);
  if (region.kind !== 'region' && region.kind !== 'none') return region;
  const replay = await receipt(p, scope, key, isRegionOpen(command) ? command.capabilities : undefined);
  if (replay) return replay;
  const recording = await p.recording?.fence(scope, originalRecordingGeneration(command));
  if (recording?.kind === 'unavailable') return refuse('SERVICE_UNAVAILABLE');

  const started = await startOf(p, scope, command);
  if (started.kind !== 'started') return started;
  const common = {
    kind: 'prepared' as const,
    ...(recording?.kind === 'recording' ? { recordingGeneration: recording.scope.generation } : {}),
    session: started.session,
    creates: started.creates,
    ...(started.source ? { source: started.source } : {}),
    mode: started.mode,
    now: started.now,
  };

  const stored = await storedBuffer(p, scope, command, started, region);
  if (stored.buffer)
    return {
      ...common,
      links: [],
      ranking: { kind: 'buffered', buffer: stored.buffer },
      reason: 'no_eligible_content',
      decisionId: stored.buffer.decisionId,
    };

  const found = await retrieve(p, scope, command, started, region);
  if (found.kind !== 'retrieved') return found;
  const { snapshot, truncated } = await rankingInput(p, scope, command, started, found, stored.assessments);
  return {
    ...common,
    links: found.links,
    ranking: { kind: 'rank', snapshot },
    reason: found.reason,
    decisionId: p.newId(),
    ...(region.kind === 'region'
      ? {
          region: {
            constraint: region.value,
            candidates: found.regionCandidates,
            hasMore: found.regionHasMore || truncated,
          },
        }
      : {}),
  };
}

/** Validates the session and capabilities and reads the source content a move starts from. */
async function startOf(
  p: NavigationPorts,
  scope: PersonalScopeTx,
  command: NavigationCommand,
): Promise<Start | NavigationResult> {
  const isNavigation = 'intent' in command;
  const sessionRef = isNavigation
    ? { sessionId: command.sessionId, expectedIntentRevision: command.expectedIntentRevision }
    : command.session;
  const existing = sessionRef ? await p.readSession(scope, sessionRef.sessionId) : undefined;
  if (sessionRef && !existing) return refuse('NOT_FOUND');
  if (existing && existing.intentRevision !== sessionRef!.expectedIntentRevision)
    return refuse('INTENT_REVISION_STALE');
  const capabilities = isNavigation ? existing!.capabilities : command.capabilities;
  const parsed = ClientCapabilities.safeParse(capabilities);
  if (!parsed.success) return refuse('UNPROCESSABLE_REQUEST');
  const session: ComposerSession = {
    id: existing?.id ?? p.newId(),
    privacyEpoch: scope.authority.privacyEpoch,
    intentRevision: existing ? existing.intentRevision + 1 : 0,
    capabilities: json(capabilities),
  };
  const start: Start = {
    kind: 'started',
    session,
    creates: !existing,
    ...(existing ? { existing } : {}),
    capabilities,
    formats: renderableFormats(parsed.data.documentSchemas),
    mode: isNavigation
      ? command.intent.mode
      : command.target.kind === 'return'
        ? ('return' as const)
        : ('vertical' as const),
    now: p.now(),
  };
  if (!isNavigation) return start;
  const member = await p.readMember(scope, command.sessionId, command.from.offerId, command.from.exposureId);
  if (!member) return refuse('OFFER_UNAVAILABLE');
  const sourceContent = await p.readExactEncounter(scope, { ...ref(member.offer.descriptor), capabilities });
  if (!sourceContent) return refuse('OFFER_UNAVAILABLE');
  return { ...start, source: { ...command.from }, sourceContent };
}

/**
 * What the worker prepared for this exact vertical move: the buffer itself while it is within its
 * life, otherwise only its Jev assessments while those are. Anything else is ranked from scratch.
 */
async function storedBuffer(
  p: NavigationPorts,
  scope: PersonalScopeTx,
  command: NavigationCommand,
  start: Start,
  region: CommandRegion,
): Promise<{ buffer?: PreparedBuffer; assessments?: SemanticAssessments }> {
  if (!p.buffers || !start.existing || !('intent' in command) || command.intent.mode !== 'vertical') return {};
  if (region.kind === 'region') return {};
  // A cache nobody can use again is deleted by the navigation that finds it, so it does not linger.
  await p.buffers.purgeExpired(scope, start.now);
  const buffer = await p.buffers.read(scope, {
    sessionId: command.sessionId,
    intentRevision: start.existing.intentRevision,
    source: command.from,
  });
  if (!buffer) return {};
  if (bufferIsServable(buffer, start.now)) return { buffer };
  const assessments = validAssessments(buffer.assessments, start.now);
  return assessments ? { assessments } : {};
}

/** Retrieves the candidates for the command's mode. */
async function retrieve(
  p: NavigationPorts,
  scope: PersonalScopeTx,
  command: NavigationCommand,
  start: Start,
  region: CommandRegion,
): Promise<Retrieved | NavigationResult> {
  const nothing: Retrieved = {
    kind: 'retrieved',
    candidates: [],
    links: [],
    reason: 'no_eligible_content',
    regionCandidates: [],
    regionHasMore: false,
  };
  switch (start.mode) {
    case 'vertical':
      return region.kind === 'region'
        ? retrieveRegion(p, scope, command, start, region)
        : {
            ...nothing,
            candidates: await readVerticalCandidates(p.readDiscoveryCandidates, scope, {
              ...(start.sourceContent ? { source: start.sourceContent } : {}),
              formats: start.formats,
              capabilities: start.capabilities,
            }),
          };
    case 'return':
      return retrieveReturn(p, scope, command, start);
    case 'variant':
      return 'intent' in command && command.intent.mode === 'variant'
        ? retrieveVariant(p, scope, command.intent, start)
        : nothing;
    case 'series':
    case 'related':
      return 'intent' in command &&
        (command.intent.mode === 'series' || command.intent.mode === 'related') &&
        start.sourceContent
        ? retrieveContinuation(p, scope, command.intent, start.sourceContent, start.capabilities)
        : nothing;
  }
}

async function retrieveRegion(
  p: NavigationPorts,
  scope: PersonalScopeTx,
  command: NavigationCommand,
  start: Start,
  region: Extract<CommandRegion, { kind: 'region' }>,
): Promise<Retrieved | NavigationResult> {
  const expected = isRegionOpen(command) ? command.expectedEncounter : undefined;
  const result = await p.readRegionCandidates(scope, {
    topicId: region.value.topicId,
    facetId: region.value.facetId,
    truthStatus: region.value.truthStatus,
    capabilities: start.capabilities,
    ...(expected ? { expected: ref(expected) } : {}),
  });
  if (result.kind !== 'read') return refuse('OFFER_UNAVAILABLE');
  const candidates = result.candidates.map((x) => x.encounter);
  const exact = expected ? ref(expected) : undefined;
  if (exact && !candidates.some((candidate) => same(candidate, exact))) return refuse('OFFER_UNAVAILABLE');
  return {
    kind: 'retrieved',
    candidates,
    links: [],
    ...(exact ? { exact } : {}),
    reason: 'no_eligible_content',
    regionCandidates: result.candidates,
    regionHasMore: result.hasMore,
  };
}

async function retrieveReturn(
  p: NavigationPorts,
  scope: PersonalScopeTx,
  command: NavigationCommand,
  start: Start,
): Promise<Retrieved> {
  const target =
    'intent' in command
      ? command.intent.mode === 'return'
        ? ref(command.intent.target)
        : undefined
      : command.target.kind === 'return'
        ? ref(command.target)
        : undefined;
  const candidate = target
    ? await p.readExactEncounter(scope, { ...target, capabilities: start.capabilities })
    : undefined;
  return {
    kind: 'retrieved',
    candidates: candidate ? [candidate] : [],
    links: [],
    ...(target ? { exact: target } : {}),
    reason: 'return_unavailable',
    regionCandidates: [],
    regionHasMore: false,
  };
}

async function retrieveVariant(
  p: NavigationPorts,
  scope: PersonalScopeTx,
  intent: Extract<Intent, { mode: 'variant' }>,
  start: Start,
): Promise<Retrieved> {
  const sibling = start.sourceContent?.siblings.find((s) => s.kind === intent.to);
  const exact = sibling ? ref(sibling) : undefined;
  const candidate = exact
    ? await p.readExactEncounter(scope, { ...exact, capabilities: start.capabilities })
    : undefined;
  const sameExplanation = candidate && candidate.explanationUnitId === start.sourceContent!.explanationUnitId;
  return {
    kind: 'retrieved',
    candidates: sameExplanation ? [candidate] : [],
    links: [],
    ...(exact ? { exact } : {}),
    reason: 'variant_unavailable',
    regionCandidates: [],
    regionHasMore: false,
  };
}

async function retrieveContinuation(
  p: NavigationPorts,
  scope: PersonalScopeTx,
  intent: Extract<Intent, { mode: 'series' | 'related' }>,
  source: EncounterSnapshot,
  capabilities: unknown,
): Promise<Retrieved | NavigationResult> {
  const direction = intent.mode === 'series' ? intent.direction : 'related';
  const reason = intent.mode === 'series' ? 'series_boundary' : 'no_related_ready';
  const expected = intent.expectedContinuation;
  const all = await p.readContinuations(scope, ref(source));
  const link = all.find(
    (l) => l.direction === direction && (!expected || (l.linkId === expected.linkId && same(l.target, expected))),
  );
  if (expected && !link) return refuse('OFFER_UNAVAILABLE');
  const exact = link ? ref(link.target) : undefined;
  const candidate = exact ? await p.readExactEncounter(scope, { ...exact, capabilities }) : undefined;
  return {
    kind: 'retrieved',
    candidates: candidate ? [candidate] : [],
    links: link ? [link] : [],
    ...(exact ? { exact } : {}),
    reason,
    regionCandidates: [],
    regionHasMore: false,
  };
}

/** Reads Hide and prepared context for the retrieved candidates and builds the immutable ranking input. */
async function rankingInput(
  p: NavigationPorts,
  scope: PersonalScopeTx,
  command: NavigationCommand,
  start: Start,
  found: Retrieved,
  assessments: SemanticAssessments | undefined,
): Promise<{ snapshot: ComposerSnapshot; truncated: boolean }> {
  const query = evidenceQueryFor(found.candidates, start.now.toISOString());
  const hiddenAssetIds = await p.readHidden(scope, query.candidateAssetIds ?? []);
  const evidence = await p.readPrepared(scope, query);
  const variantFormat = 'intent' in command && command.intent.mode === 'variant' ? command.intent.to : undefined;
  const mode: ComposerSnapshot['mode'] =
    start.mode === 'series' || start.mode === 'related' ? 'horizontal' : start.mode;
  return assembleSnapshot({
    universeId: scope.authority.universeId,
    privacyEpoch: scope.authority.privacyEpoch,
    evaluatedAt: start.now.toISOString(),
    seed: command.commandId,
    mode,
    ...(start.sourceContent ? { source: start.sourceContent } : {}),
    candidates: found.candidates,
    hiddenAssetIds,
    links: found.links,
    ...(found.exact ? { exactTarget: found.exact } : {}),
    ...(variantFormat ? { variantFormat } : {}),
    ...(evidence ? { evidence } : {}),
    ...(assessments ? { semanticAssessments: assessments } : {}),
    fallbackContextWatermark: `unprepared:${String(scope.revisionAtEntry)}`,
    hashCatalogWatermarks: (watermarks) => p.hashRequest('content-candidate-watermarks', [...watermarks]),
  });
}

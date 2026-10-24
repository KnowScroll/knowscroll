import type {
  Assumption,
  ContentThreadRef,
  ScenarioCard,
  ScenarioKind,
  ScenarioOption,
  ScenarioParent,
  ScenarioSuggestion,
} from '@knowscroll/contracts';
import type { AccountScope } from './account-scope';
import { apiProblem } from './api-client';
import { talkFailure } from './talk-failure';

const VERSION = 'scenario.v1' as const;

type ChooseInput = Parameters<AccountScope['api']['scenarios']['choose']>[0];
/** One of the draft's directions by ID, or the member's own complete request. */
export type ScenarioSelection = ChooseInput['selection'];

// --- The thread's branches -------------------------------------------------------------------

export interface ScenarioBoardState {
  /** `unavailable`: not a member any more, or the thread ended. */
  readonly phase: 'loading' | 'ready' | 'unavailable' | 'failed';
  /** The thread's branches, oldest first, removed ones included. */
  readonly cards: readonly ScenarioCard[];
  /** What this member was offered and has not made: private to them, not branches, never numbered. */
  readonly suggestions: readonly ScenarioSuggestion[];
  /** The last read did not arrive; what is shown may be out of date. */
  readonly offline: boolean;
}

export interface ScenarioBoardController {
  readonly getState: () => ScenarioBoardState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Reads the branches afresh. A hint, a focus, a poll or a returning app all call this. */
  readonly load: () => Promise<void>;
  /** Takes a branch the person started off the thread's cards. Returns whether the server accepted. */
  readonly remove: (card: ScenarioCard) => Promise<boolean>;
}

/**
 * The branches of one thread as cards. The server owns them and each card's state (preparing, ready,
 * unable to prepare); this reads them, and every read is "ask again", so a lost hint only delays an
 * update. Nothing here records which branch anyone is on: that is each person's own and stays on the
 * device.
 */
export function createScenarioBoard(options: {
  readonly scope: AccountScope;
  readonly thread: ContentThreadRef;
  readonly newId: () => string;
}): ScenarioBoardController {
  const { scope, thread, newId } = options;
  const listeners = new Set<() => void>();
  let state: ScenarioBoardState = { phase: 'loading', cards: [], suggestions: [], offline: false };
  /** A removal that may or may not have reached the server keeps its command, so a retry is the same command. */
  const removals = new Map<string, string>();
  const publish = (patch: Partial<ScenarioBoardState>) => {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };

  async function load(): Promise<void> {
    try {
      const list = await scope.api.scenarios.list({ version: VERSION, readId: newId(), thread });
      if (list.status === 'unavailable') publish({ phase: 'unavailable', cards: [], suggestions: [], offline: false });
      else publish({ phase: 'ready', cards: list.cards, suggestions: list.suggestions, offline: false });
    } catch (error) {
      const kind = talkFailure(error);
      if (kind === 'ended') return;
      if (kind === 'unavailable') publish({ phase: 'unavailable', cards: [], suggestions: [] });
      else if (state.phase === 'loading') publish({ phase: 'failed', offline: kind === 'offline' });
      else publish({ offline: true });
    }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    load,
    async remove(card) {
      const key = `${card.nodeId}:${String(card.revision)}`;
      const commandId = removals.get(key) ?? newId();
      removals.set(key, commandId);
      try {
        await scope.api.scenarios.remove({
          version: VERSION,
          commandId,
          thread,
          nodeId: card.nodeId,
          revision: card.revision,
        });
        removals.delete(key);
        await load();
        return true;
      } catch (error) {
        // The card moved or the place ended: read again, and let the person ask once more if they still can.
        if (talkFailure(error) !== 'offline') removals.delete(key);
        await load();
        return false;
      }
    },
  };
}

// --- The composer: ask, see directions, choose -----------------------------------------------

/** What a member asked for: the kind, where in the thread it came from and the revision of what it continues. */
export interface ScenarioAsk {
  readonly kind: ScenarioKind;
  readonly origin: { readonly kind: 'root' } | { readonly kind: 'message'; readonly messageId: string };
  readonly parent: ScenarioParent;
  readonly text: string;
}

/**
 * - `sending`: the ask is on its way.
 * - `thinking`: a worker is proposing directions; the member may already submit their own.
 * - `ready`: directions are here (`mode`: one clear idea, or a few to pick from).
 * - `failed`: no directions came; the member can still submit their own complete request.
 * - `choosing`: the choice is on its way.
 * - `chosen`: the branch exists and is preparing (or already was: `reused`).
 * - `blocked`: something stopped it; `block` says what, in the few ways a screen treats differently.
 */
export type ScenarioComposerPhase =
  'idle' | 'sending' | 'thinking' | 'ready' | 'failed' | 'choosing' | 'chosen' | 'blocked';
export type ScenarioBlock = 'budget' | 'unsupported' | 'invalid' | 'stale' | 'unavailable' | 'offline';

export interface ScenarioComposerState {
  readonly phase: ScenarioComposerPhase;
  readonly ask: ScenarioAsk | undefined;
  readonly mode: 'direct' | 'options' | undefined;
  readonly options: readonly ScenarioOption[];
  readonly failure: 'could_not_suggest' | 'budget_unavailable' | undefined;
  readonly block: ScenarioBlock | undefined;
  readonly chosen: { readonly card: ScenarioCard; readonly reused: boolean } | undefined;
}

export interface ScenarioComposerController {
  readonly getState: () => ScenarioComposerState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Asks. The same ask under one command: a retry after a lost answer is the same draft. */
  readonly begin: (ask: ScenarioAsk) => Promise<void>;
  /** Looks at the draft again while it is thinking. A poll calls this. */
  readonly refresh: () => Promise<void>;
  /** Picks up a draft the member already has (an offer they have not made): its directions come back as `ready`. */
  readonly attach: (draftId: string) => Promise<void>;
  /** Chooses one direction or submits the member's own request. Only this commissions anything. */
  readonly choose: (selection: ScenarioSelection) => Promise<void>;
  /** Tries the step that was blocked by a lost answer again, with the same command. */
  readonly retry: () => Promise<void>;
  readonly reset: () => void;
}

const idle: ScenarioComposerState = {
  phase: 'idle',
  ask: undefined,
  mode: undefined,
  options: [],
  failure: undefined,
  block: undefined,
  chosen: undefined,
};

/** The few ways a refused or lost command reads to a screen. */
function blockOf(error: unknown): ScenarioBlock | 'ended' {
  const kind = talkFailure(error);
  if (kind === 'ended') return 'ended';
  if (kind === 'offline') return 'offline';
  if (kind === 'stale') return 'stale';
  const code = apiProblem(error)?.code;
  if (code === 'TOO_MANY_REQUESTS') return 'budget';
  if (code === 'UNPROCESSABLE_REQUEST') return 'unsupported';
  if (code === 'INVALID_REQUEST') return 'invalid';
  return 'unavailable';
}

/**
 * One member's composer for What if and Another perspective (X01). It asks the server for directions
 * (no content is made by asking), shows what comes back, and sends the one command that commissions: a
 * choice. Every command keeps its ID for the intent it carries, so a retry after a lost answer is the
 * same command and can never make two branches. The draft is private to the member; nothing here
 * reaches the thread until a branch exists.
 */
export function createScenarioComposer(options: {
  readonly scope: AccountScope;
  readonly thread: ContentThreadRef;
  readonly newId: () => string;
}): ScenarioComposerController {
  const { scope, thread, newId } = options;
  const listeners = new Set<() => void>();
  let state = idle;
  let draftId: string | undefined;
  let askCommandId = newId();
  let lastStep: (() => Promise<void>) | undefined;
  const choiceCommands = new Map<string, string>();
  const publish = (patch: Partial<ScenarioComposerState>) => {
    if (!scope.active) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };
  const block = (error: unknown) => {
    const why = blockOf(error);
    if (why !== 'ended') publish({ phase: 'blocked', block: why });
  };

  async function refresh(): Promise<void> {
    if (state.phase !== 'thinking' || draftId === undefined) return;
    try {
      const view = await scope.api.scenarios.readDraft({ version: VERSION, readId: newId(), thread, draftId });
      if (state.phase !== 'thinking') return;
      if (view.status === 'ready') publish({ phase: 'ready', mode: view.mode, options: view.options });
      else if (view.status === 'failed') publish({ phase: 'failed', failure: view.reason });
      else if (view.status === 'unavailable') publish({ phase: 'blocked', block: 'unavailable' });
    } catch (error) {
      // A poll that gets no answer simply asks again; a refusal ends the draft.
      if (blockOf(error) !== 'offline') block(error);
    }
  }

  async function send(ask: ScenarioAsk): Promise<void> {
    publish({ phase: 'sending', block: undefined });
    try {
      const started = await scope.api.scenarios.draft({
        version: VERSION,
        commandId: askCommandId,
        thread,
        kind: ask.kind,
        origin: ask.origin,
        parent: ask.parent,
        text: ask.text,
      });
      draftId = started.draftId;
      publish({ phase: 'thinking' });
      await refresh();
    } catch (error) {
      lastStep = () => send(ask);
      block(error);
    }
  }

  async function choose(selection: ScenarioSelection): Promise<void> {
    if (draftId === undefined) return;
    const key = JSON.stringify(selection);
    const commandId = choiceCommands.get(key) ?? newId();
    choiceCommands.set(key, commandId);
    publish({ phase: 'choosing', block: undefined });
    try {
      const accepted = await scope.api.scenarios.choose({
        version: VERSION,
        commandId,
        thread,
        draftId,
        selection,
      });
      publish({ phase: 'chosen', chosen: { card: accepted.node, reused: accepted.reused } });
    } catch (error) {
      lastStep = () => choose(selection);
      // A refusal is final for this choice; a lost answer keeps its command for the retry.
      if (blockOf(error) !== 'offline') choiceCommands.delete(key);
      block(error);
    }
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    begin: (ask) => {
      if (state.phase === 'sending' || state.phase === 'choosing') return Promise.resolve();
      draftId = undefined;
      askCommandId = newId();
      choiceCommands.clear();
      lastStep = undefined;
      state = { ...idle, ask };
      return send(ask);
    },
    refresh,
    attach: (id) => {
      draftId = id;
      askCommandId = newId();
      choiceCommands.clear();
      lastStep = undefined;
      publish({ ...idle, phase: 'thinking' });
      return refresh();
    },
    choose,
    retry: () => (lastStep === undefined ? Promise.resolve() : lastStep()),
    reset: () => {
      draftId = undefined;
      lastStep = undefined;
      choiceCommands.clear();
      askCommandId = newId();
      publish({ ...idle });
    },
  };
}

// --- Words -----------------------------------------------------------------------------------

/**
 * The subject of an assumption the member typed as one sentence: its first words, as short as a
 * subject is meant to be. Code names it so the member is never asked to configure a simulation.
 */
export function subjectOfStatement(statement: string): string {
  const words = statement.trim().split(/\s+/u).slice(0, 3).join(' ');
  const subject = words.length > 40 ? words.slice(0, 40).trimEnd() : words;
  return subject.length >= 2 ? subject : 'This idea';
}

/**
 * One line of the member's own request. `subject` is the one an edited suggestion already had, or the
 * subject of the earlier premise this line replaces; a line without one adds a premise of its own.
 */
export interface OwnRow {
  readonly statement: string;
  readonly subject?: string | undefined;
}

const MIN_STATEMENT = 3;

/**
 * The member's complete request as the server takes it, or nothing while it is not complete: a what-if
 * needs one sentence that changes something, a perspective needs a lens. A line keeps its subject when it
 * has one (so it replaces the premise of that subject instead of standing beside it); a new line is named
 * by its first words, and so adds a premise.
 */
export function ownSelection(request: {
  readonly kind: ScenarioKind;
  readonly changes: readonly OwnRow[];
  readonly kept: readonly OwnRow[];
  readonly lens: string;
}): Extract<ScenarioSelection, { kind: 'own' }> | undefined {
  if (request.kind === 'perspective') {
    const lens = request.lens.trim();
    return lens.length >= MIN_STATEMENT ? { kind: 'own', changes: [], kept: [], lens } : undefined;
  }
  const assumptions = (rows: readonly OwnRow[]): Assumption[] =>
    rows
      .map((row) => ({ subject: row.subject ?? subjectOfStatement(row.statement), statement: row.statement.trim() }))
      .filter((row) => row.statement.length >= MIN_STATEMENT);
  const changes = assumptions(request.changes);
  return changes.length === 0 ? undefined : { kind: 'own', changes, kept: assumptions(request.kept) };
}

/** One assumption the way a chip says it: "Changed: traffic is ten times higher". */
export const chipText = (prefix: 'Changed' | 'Kept', assumption: Assumption): string =>
  `${prefix}: ${assumption.statement.charAt(0).toLowerCase()}${assumption.statement.slice(1)}`;

/** The summary a screen reader gets for an option: what changes, what stays, or the lens. */
export function describeOption(option: Pick<ScenarioOption, 'changes' | 'kept' | 'lens'>): string {
  if (option.lens !== undefined) return `Another perspective: ${option.lens}.`;
  const changed = option.changes.map((change) => chipText('Changed', change)).join('. ');
  const kept = option.kept.map((keep) => chipText('Kept', keep)).join('. ');
  return [changed, kept].filter((part) => part !== '').join('. ') + '.';
}

/** The kind of a card in the reader's words, for its kicker and its accessible name. */
export const kindWord = (card: Pick<ScenarioCard, 'kind'>): string =>
  card.kind === 'what_if' ? 'What if' : 'Another perspective';

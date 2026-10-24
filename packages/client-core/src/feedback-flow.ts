import {
  REPORT_NOTE_MAX,
  type AbuseCategory,
  type AbuseReportRequest,
  type ContentErrorAnchor,
  type ContentErrorCategory,
  type ContentErrorReportRequest,
  type ReportReceipt,
} from '@knowscroll/contracts';
import type { FeedbackStore, QueuedReport, ReportOutcome } from './feedback-store';

/** A person the report names, as the screen already shows them: enough to offer "Also block". */
export interface ReportedPerson {
  readonly personId: string;
  readonly displayName: string;
  readonly handle: string;
}

/**
 * What a report is about, as the screen holds it. A Reel or Scroll carries the exact revision on
 * screen and, for a content error, where in it the person was.
 */
export type FeedbackTarget =
  | {
      readonly kind: 'asset';
      readonly assetId: string;
      readonly assetRevision: number;
      readonly title: string;
      readonly format: 'reel' | 'scroll';
      /** Where the person was: the moment of a Reel or the block of a Scroll. */
      readonly anchor?: ContentErrorAnchor;
    }
  | { readonly kind: 'message'; readonly messageId: string; readonly author?: ReportedPerson }
  | { readonly kind: 'room_message'; readonly messageId: string; readonly author?: ReportedPerson }
  | { readonly kind: 'person'; readonly person: ReportedPerson };

export type ReportKind = 'content_error' | 'abuse';

export type ReportStep =
  /** Choosing what to do (P03's menu). Only a Reel or Scroll has one. */
  | 'menu'
  | 'content_error'
  | 'abuse'
  | 'sending'
  /** The server answered with a receipt. */
  | 'received'
  /** No answer: kept, and sent again by itself. "Will send when online." */
  | 'queued'
  /** Refused or the server had trouble. Only `try_again` has a Retry, with the same command ID. */
  | 'failed';

export interface ReportFlowState {
  readonly step: ReportStep;
  /** The form the person is in or came from. */
  readonly kind: ReportKind | undefined;
  readonly contentCategory: ContentErrorCategory;
  readonly abuseCategory: AbuseCategory | undefined;
  readonly note: string;
  /** Whether a content error carries the place in the Reel or Scroll. */
  readonly anchored: boolean;
  readonly canSend: boolean;
  readonly failure: Extract<ReportOutcome, { status: 'refused' }>['reason'] | undefined;
  readonly receipt: ReportReceipt | undefined;
  /** Whether "Also block" is offered, and where it stands. */
  readonly block: 'unavailable' | 'offered' | 'blocking' | 'blocked' | 'failed';
}

export interface ReportFlow {
  readonly getState: () => ReportFlowState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly chooseContentError: () => void;
  readonly chooseAbuse: () => void;
  readonly setContentCategory: (category: ContentErrorCategory) => void;
  readonly setAbuseCategory: (category: AbuseCategory) => void;
  readonly setNote: (note: string) => void;
  readonly toggleAnchor: () => void;
  /** From a form back to the menu (or, with no menu, nowhere: the screen closes). */
  readonly back: () => boolean;
  /** Sends the report. Calling it again after a failure repeats the same command ID. */
  readonly send: () => Promise<void>;
  /** Blocks the person the report names. */
  readonly block: () => Promise<void>;
}

export interface ReportFlowOptions {
  readonly target: FeedbackTarget;
  readonly store: Pick<FeedbackStore, 'sendReport' | 'blockPerson'>;
  readonly newId: () => string;
  /** The form to open on. A message or a person has no menu and opens on the abuse form. */
  readonly start: 'menu' | ReportKind;
}

/** The person the target names, when there is one to block. */
export function reportedPersonOf(target: FeedbackTarget): ReportedPerson | undefined {
  return target.kind === 'person' ? target.person : target.kind === 'asset' ? undefined : target.author;
}

function abuseTarget(target: FeedbackTarget): AbuseReportRequest['target'] {
  switch (target.kind) {
    case 'asset':
      return { kind: 'asset', assetId: target.assetId, assetRevision: target.assetRevision };
    case 'person':
      return { kind: 'person', personId: target.person.personId };
    case 'message':
    case 'room_message':
      return { kind: target.kind, messageId: target.messageId };
  }
}

/**
 * The state behind P03's forms: pick what is wrong, add a note if you like, send, and see the receipt.
 * The command ID is minted when a report is first sent and kept for every retry of that same report;
 * changing the form after a failure makes a new report with a new ID. A note that is only spaces is
 * no note. The flow reads nothing back: it never learns what became of a report, and nothing it
 * holds is kept once the sheet closes.
 */
export function createReportFlow(options: ReportFlowOptions): ReportFlow {
  const { target, store, newId } = options;
  const person = reportedPersonOf(target);
  const listeners = new Set<() => void>();
  let intent: { readonly commandId: string; readonly body: string } | undefined;
  interface Form {
    step: ReportStep;
    kind: ReportKind | undefined;
    contentCategory: ContentErrorCategory;
    abuseCategory: AbuseCategory | undefined;
    note: string;
    anchored: boolean;
    failure: ReportFlowState['failure'];
    receipt: ReportReceipt | undefined;
    block: ReportFlowState['block'];
  }
  let form: Form = {
    step: options.start,
    kind: options.start === 'menu' ? undefined : options.start,
    contentCategory: 'wrong',
    abuseCategory: undefined,
    note: '',
    anchored: target.kind === 'asset' && target.anchor !== undefined,
    failure: undefined,
    receipt: undefined,
    block: person === undefined ? 'unavailable' : 'offered',
  };
  let state = derive();

  function derive(): ReportFlowState {
    const ready = form.kind === 'content_error' || form.abuseCategory !== undefined;
    return { ...form, canSend: (form.step === 'content_error' || form.step === 'abuse') && ready };
  }
  function publish(patch: Partial<Form>): void {
    form = { ...form, ...patch };
    state = derive();
    for (const listener of [...listeners]) listener();
  }

  const trimmedNote = (): string | undefined => {
    const note = form.note.trim();
    return note === '' ? undefined : note;
  };

  function buildReport(commandId: string): QueuedReport {
    const note = trimmedNote();
    if (form.kind === 'content_error' && target.kind === 'asset') {
      const request: ContentErrorReportRequest = {
        commandId,
        target: { assetId: target.assetId, assetRevision: target.assetRevision },
        category: form.contentCategory,
        ...(form.anchored && target.anchor !== undefined ? { anchor: target.anchor } : {}),
        ...(note === undefined ? {} : { note }),
      };
      return { kind: 'content_error', request };
    }
    const request: AbuseReportRequest = {
      commandId,
      target: abuseTarget(target),
      category: form.abuseCategory!,
      ...(note === undefined ? {} : { note }),
    };
    return { kind: 'abuse', request };
  }

  /** The body of the report as it would go, without the ID: what makes this the same report. */
  const bodyOf = (): string => JSON.stringify(buildReport('0'));

  /** Editing after a failure is a different report: it gets its own ID the next time it is sent. */
  const edited = (patch: Partial<Form>): void => {
    publish({ ...patch, ...(form.step === 'failed' ? { step: form.kind ?? 'abuse', failure: undefined } : {}) });
  };

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    chooseContentError: () => {
      if (target.kind === 'asset') publish({ step: 'content_error', kind: 'content_error' });
    },
    chooseAbuse: () => publish({ step: 'abuse', kind: 'abuse' }),
    setContentCategory: (category) => edited({ contentCategory: category }),
    setAbuseCategory: (category) => edited({ abuseCategory: category }),
    setNote: (note) => edited({ note: note.slice(0, REPORT_NOTE_MAX) }),
    toggleAnchor: () => {
      if (target.kind === 'asset' && target.anchor !== undefined) edited({ anchored: !form.anchored });
    },
    back() {
      if (options.start !== 'menu' || (form.step !== 'content_error' && form.step !== 'abuse')) return false;
      publish({ step: 'menu' });
      return true;
    },
    async send() {
      if (form.step === 'sending' || form.step === 'received' || form.step === 'queued') return;
      if (form.kind === undefined || (form.kind === 'abuse' && form.abuseCategory === undefined)) return;
      const body = bodyOf();
      if (intent === undefined || intent.body !== body) intent = { commandId: newId(), body };
      publish({ step: 'sending', failure: undefined });
      const outcome = await store.sendReport(buildReport(intent.commandId));
      if (outcome.status === 'received') publish({ step: 'received', receipt: outcome.receipt });
      else if (outcome.status === 'queued') publish({ step: 'queued' });
      else publish({ step: 'failed', failure: outcome.reason });
    },
    async block() {
      if (person === undefined || form.block === 'blocking' || form.block === 'blocked') return;
      publish({ block: 'blocking' });
      publish({ block: (await store.blockPerson(person.personId)) ? 'blocked' : 'failed' });
    },
  };
}

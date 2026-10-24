import { UuidSchema, type JourneyResponse, type OperatorPanelsResponse } from '@knowscroll/contracts';
import { apiProblem, type ApiClient } from './api-client';

interface OperatorOwner {
  readonly api: Pick<ApiClient, 'operator'>;
  readonly active: boolean;
}

/**
 * The panels. `not_operator` is the server's 404: this account is not an operator of this world,
 * which the screen shows as an unknown page. `unavailable` is anything else that went wrong; the
 * last good panels stay on screen with `stale` set.
 */
export type OperatorPanelsState =
  | { readonly status: 'loading' }
  | { readonly status: 'not_operator' }
  | { readonly status: 'unavailable' }
  | {
      readonly status: 'ready';
      readonly panels: OperatorPanelsResponse;
      /** When the panels were read (milliseconds), so "read 20 s ago" never depends on a clock read while drawing. */
      readonly readAt: number;
      readonly stale: boolean;
    };

/** The journey lookup. `invalid` is an input that is not an ID, which is never sent. */
export type OperatorJourneyState =
  | { readonly status: 'idle' }
  | { readonly status: 'invalid' }
  | { readonly status: 'loading'; readonly id: string }
  | { readonly status: 'found'; readonly journey: JourneyResponse }
  | { readonly status: 'not_found'; readonly id: string }
  | { readonly status: 'unavailable'; readonly id: string };

export interface OperatorState {
  readonly panels: OperatorPanelsState;
  readonly journey: OperatorJourneyState;
}

export interface OperatorSession {
  readonly getState: () => OperatorState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Reads the panels again. */
  readonly refresh: () => Promise<void>;
  /** Looks up the journey of the ID in `input` (surrounding spaces ignored). */
  readonly lookUp: (input: string) => Promise<void>;
  readonly clearLookup: () => void;
}

/**
 * The Operator screen's state for one account scope (#248, D-044). It only reads. A 404 from either
 * route means the account is not an operator, and nothing more is asked. Answers that arrive after
 * the scope ended are dropped by its fenced requests and by `active`.
 */
export function createOperatorSession(owner: OperatorOwner): OperatorSession {
  let state: OperatorState = { panels: { status: 'loading' }, journey: { status: 'idle' } };
  const listeners = new Set<() => void>();
  let panelsSerial = 0;
  let journeySerial = 0;

  function set(next: Partial<OperatorState>): void {
    if (!owner.active) return;
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener();
  }

  const isNotFound = (error: unknown): boolean => apiProblem(error)?.code === 'NOT_FOUND';

  async function refresh(): Promise<void> {
    const mine = (panelsSerial += 1);
    try {
      const panels = await owner.api.operator.panels();
      if (mine === panelsSerial) set({ panels: { status: 'ready', panels, readAt: Date.now(), stale: false } });
    } catch (error) {
      if (mine !== panelsSerial) return;
      if (isNotFound(error)) set({ panels: { status: 'not_operator' } });
      else if (state.panels.status === 'ready') set({ panels: { ...state.panels, stale: true } });
      else set({ panels: { status: 'unavailable' } });
    }
  }

  async function lookUp(input: string): Promise<void> {
    const parsed = UuidSchema.safeParse(input.trim());
    const mine = (journeySerial += 1);
    if (!parsed.success) {
      set({ journey: { status: 'invalid' } });
      return;
    }
    const id = parsed.data;
    set({ journey: { status: 'loading', id } });
    try {
      const journey = await owner.api.operator.journey({ id });
      if (mine === journeySerial) set({ journey: { status: 'found', journey } });
    } catch (error) {
      if (mine !== journeySerial) return;
      if (isNotFound(error)) set({ journey: { status: 'not_found', id } });
      else set({ journey: { status: 'unavailable', id } });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    lookUp,
    clearLookup() {
      journeySerial += 1;
      set({ journey: { status: 'idle' } });
    },
  };
}

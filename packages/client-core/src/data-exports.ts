import type { DataExportSummary } from '@knowscroll/contracts';
import { apiProblem, type ApiClient } from './api-client';

interface ExportsOwner {
  readonly api: Pick<ApiClient, 'account'>;
  readonly active: boolean;
}

/**
 * The person's export receipts for P02 "History & export". `opening` names the export a download
 * link is being made for. `failed` says which action did not go through; receipts are as they were.
 */
export interface DataExportsState {
  readonly status: 'loading' | 'ready' | 'unavailable';
  readonly exports: readonly DataExportSummary[];
  readonly requesting: boolean;
  readonly opening: string | undefined;
  readonly failed: 'request' | 'download' | undefined;
}

export interface DataExportsSession {
  readonly getState: () => DataExportsState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly refresh: () => Promise<void>;
  /** Asks for a new export (or, while one is preparing, shows that one), then rereads. */
  readonly request: () => Promise<void>;
  /**
   * Makes a one-time download link for a ready export and hands its API-relative path to `open`
   * (the platform decides how a download opens). The path is a credential for a minute: it is
   * never kept in state.
   */
  readonly download: (exportId: string, open: (path: string) => void) => Promise<void>;
}

export function createDataExportsSession(
  owner: ExportsOwner,
  newId: () => string = () => globalThis.crypto.randomUUID(),
): DataExportsSession {
  let state: DataExportsState = {
    status: 'loading',
    exports: [],
    requesting: false,
    opening: undefined,
    failed: undefined,
  };
  const listeners = new Set<() => void>();
  let serial = 0;

  function set(next: Partial<DataExportsState>): void {
    if (!owner.active) return;
    state = { ...state, ...next };
    for (const listener of [...listeners]) listener();
  }

  async function refresh(): Promise<void> {
    const mine = (serial += 1);
    try {
      const { exports } = await owner.api.account.exports.list();
      if (mine === serial) set({ status: 'ready', exports });
    } catch {
      if (mine === serial) set({ status: state.exports.length > 0 ? 'ready' : 'unavailable' });
    }
  }

  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    refresh,
    async request() {
      set({ requesting: true, failed: undefined });
      try {
        await owner.api.account.exports.request({ exportId: newId() });
        set({ requesting: false });
      } catch {
        set({ requesting: false, failed: 'request' });
        return;
      }
      await refresh();
    },
    async download(exportId, open) {
      set({ opening: exportId, failed: undefined });
      try {
        const link = await owner.api.account.exports.link({ exportId });
        set({ opening: undefined });
        open(link.path);
      } catch (error) {
        set({ opening: undefined, failed: 'download' });
        // Not ready (expired or already downloaded since the list was read): show the truth.
        if (apiProblem(error)?.code === 'CONFLICT' || apiProblem(error)?.code === 'NOT_FOUND') await refresh();
      }
    },
  };
}

import { useEffect, useState } from 'react';
import { ACCOUNT_DELETE_TYPED_WORD, RESET_CONFIRMATION, type PrivacyExportResult, type PrivacyResetReceipt, type Universe } from '../api/types.ts';
import type { PrivacyActionState, PrivacyView, UniverseView } from '../state/readerStore.ts';

export interface PrivacyScreenProps {
  universe: UniverseView;
  privacy: PrivacyView;
  onReturn: () => void;
  onOpenKeep?: () => void;
  onPause: () => void;
  onResume: () => void;
  onExport: () => void;
  onBeginReset: () => void;
  onCancelReset: () => void;
  onConfirmReset: (typed: string) => void;
  onAcknowledgeReset: () => void;
  onEnterScroll: () => void;
  /** #135, ADR-0034/ADR-0035: ends the session, or removes the account and everything it
   * recorded. Neither shows a completion screen inside this panel the way Reset's
   * `onAcknowledgeReset` does -- both hand off to the app's own sign-in screen instead
   * (`ReaderStore`'s `onSignedOut`), so there is nothing left here to acknowledge. */
  onSignOut: () => void;
  onBeginDeleteAccount: () => void;
  onCancelDeleteAccount: () => void;
  onConfirmDeleteAccount: (typed: string) => void;
}

/**
 * The privacy panel (#119, ADR-0030): pause/resume, export and reset, reachable from the
 * Universe level. Drawn to ui-system.md sec.5b/5c like every other surface here -- the shared
 * head band and dock -- but the panel itself is new surface the two references never covered
 * (neither Cosmos nor Living Observatory has a privacy control at all), so its interior layout is
 * this file's own, honest choice rather than a fidelity match to either reference.
 *
 * Every fact shown comes from the already-loaded `Universe` (`recordingPausedAt`/`privacyEpoch`,
 * themselves a real `GET /v1/universe`) or from a real receipt the store just received -- this
 * component invents no state, count or reassurance the wire contract does not carry.
 */
export function PrivacyScreen({
  universe,
  privacy,
  onReturn,
  onOpenKeep = onReturn,
  onPause,
  onResume,
  onExport,
  onBeginReset,
  onCancelReset,
  onConfirmReset,
  onAcknowledgeReset,
  onEnterScroll,
  onSignOut,
  onBeginDeleteAccount,
  onCancelDeleteAccount,
  onConfirmDeleteAccount,
}: PrivacyScreenProps) {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Home') {
        event.preventDefault();
        onReturn();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onReturn]);

  return (
    <main className="privacy-screen" aria-label="Privacy">
      <header className="head-band">
        <button type="button" className="pill cream" onClick={onReturn} aria-label="Return to Universe" aria-keyshortcuts="Escape">
          ‹ Universe
        </button>
        <span className="head-band-origin">Your history, your control</span>
        <span className="head-band-kind">Privacy</span>
      </header>
      <div className="privacy-stage">
        {universe.status !== 'loaded' ? (
          <div className="unavailable-block" role="alert">
            <h2>Privacy controls are unavailable</h2>
            <p className="detail">Privacy controls need your universe to be loaded first. Return to Universe and try again.</p>
          </div>
        ) : privacy.status !== 'open' ? (
          <p role="status" aria-live="polite">
            Loading…
          </p>
        ) : (
          <PrivacyPanel
            universe={universe.universe}
            action={privacy.action}
            onPause={onPause}
            onResume={onResume}
            onExport={onExport}
            onBeginReset={onBeginReset}
            onCancelReset={onCancelReset}
            onConfirmReset={onConfirmReset}
            onAcknowledgeReset={onAcknowledgeReset}
            onSignOut={onSignOut}
            onBeginDeleteAccount={onBeginDeleteAccount}
            onCancelDeleteAccount={onCancelDeleteAccount}
            onConfirmDeleteAccount={onConfirmDeleteAccount}
          />
        )}
      </div>
      <p className="keyboard-help">Keyboard: Escape or Home returns to Universe.</p>

      {/* The dock is "the frame every level shares" (ui-system.md sec.5b), so Privacy carries it
          too, exactly like System does -- no entry marked current, since Privacy is not one of the
          dock's three destinations. */}
      <nav className="universe-dock" aria-label="Main navigation">
        <button type="button" className="dock-button" onClick={onEnterScroll} aria-label="Cable — read a Scroll">
          <span className="dock-icon" aria-hidden="true">
            〜
          </span>
          Cable
        </button>
        <button type="button" className="dock-button" onClick={onReturn} aria-label="Atlas — your universe">
          <span className="dock-icon" aria-hidden="true">
            ◎
          </span>
          Atlas
        </button>
        <button type="button" className="dock-button" onClick={onOpenKeep} aria-label="Keep — your saved Traces">
          <span className="dock-icon" aria-hidden="true">
            ▱
          </span>
          Keep
        </button>
      </nav>
    </main>
  );
}

interface PrivacyPanelProps {
  universe: Universe;
  action: PrivacyActionState;
  onPause: () => void;
  onResume: () => void;
  onExport: () => void;
  onBeginReset: () => void;
  onCancelReset: () => void;
  onConfirmReset: (typed: string) => void;
  onAcknowledgeReset: () => void;
  onSignOut: () => void;
  onBeginDeleteAccount: () => void;
  onCancelDeleteAccount: () => void;
  onConfirmDeleteAccount: (typed: string) => void;
}

function PrivacyPanel({
  universe,
  action,
  onPause,
  onResume,
  onExport,
  onBeginReset,
  onCancelReset,
  onConfirmReset,
  onAcknowledgeReset,
  onSignOut,
  onBeginDeleteAccount,
  onCancelDeleteAccount,
  onConfirmDeleteAccount,
}: PrivacyPanelProps) {
  if (action.status === 'reset-complete') {
    return <ResetComplete receipt={action.receipt} onAcknowledgeReset={onAcknowledgeReset} />;
  }
  return (
    <div className="privacy-sections">
      <RecordingSection universe={universe} action={action} onPause={onPause} onResume={onResume} />
      <ExportSection action={action} onExport={onExport} />
      <ResetSection action={action} onBeginReset={onBeginReset} onCancelReset={onCancelReset} onConfirmReset={onConfirmReset} />
      <SignOutSection action={action} onSignOut={onSignOut} />
      <DeleteAccountSection
        action={action}
        onBeginDeleteAccount={onBeginDeleteAccount}
        onCancelDeleteAccount={onCancelDeleteAccount}
        onConfirmDeleteAccount={onConfirmDeleteAccount}
      />
    </div>
  );
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/**
 * The real `recordingPausedAt`/`privacyEpoch` shown here always come from the `Universe` prop --
 * itself the last real `GET /v1/universe` the store read, re-read again after every pause/resume
 * (ReaderStore.runPrivacyRecordingAction) -- never a locally-held flag that could disagree with
 * the server (#119's own honesty rule).
 */
function RecordingSection({
  universe,
  action,
  onPause,
  onResume,
}: {
  universe: Universe;
  action: PrivacyActionState;
  onPause: () => void;
  onResume: () => void;
}) {
  const paused = universe.recordingPausedAt !== null;
  const kind: 'pause' | 'resume' = paused ? 'resume' : 'pause';
  const handler = paused ? onResume : onPause;
  const pending = action.status === 'pending' && action.kind === kind;
  const failed = action.status === 'failed' && action.kind === kind ? action : null;
  const label = paused ? 'Resume recording' : 'Pause recording';

  return (
    <section className="privacy-section">
      <p className="eyebrow">Recording</p>
      {paused ? (
        <>
          <h2>Recording is paused</h2>
          <p>Paused since {formatTimestamp(universe.recordingPausedAt as string)}. Reading still works; nothing new is being recorded.</p>
        </>
      ) : (
        <>
          <h2>Recording is on</h2>
          <p>New Scrolls you&apos;re shown, and anything you keep or Ask, are being recorded for this universe.</p>
        </>
      )}
      <p className="privacy-note">
        {paused
          ? "Resuming does not restore anything from while you were paused — it only starts recording again from now."
          : 'Pausing does not erase or delete anything already recorded, and reading still works. It only stops new exposure, keep and Ask records for this universe from now on.'}
      </p>
      {failed && (
        <p className="privacy-error" role="alert">
          {failed.message}
        </p>
      )}
      <button type="button" className="pill teal" aria-label={failed ? `Retry ${label.toLowerCase()}` : label} disabled={pending} onClick={handler}>
        {failed ? 'Retry' : pending ? (paused ? 'Resuming…' : 'Pausing…') : label}
      </button>
    </section>
  );
}

/** A plain `data:` URI rather than `Blob`/`URL.createObjectURL`: the export a real personal
 * universe produces is bounded, recorded rows (never media), so there is no size pressure that
 * needs a revocable object URL's lifecycle -- a data URI needs no cleanup and is testable without
 * a DOM API this app otherwise never uses. */
function exportDownloadHref(result: PrivacyExportResult): string {
  return `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(result, null, 2))}`;
}

function exportFileName(result: PrivacyExportResult): string {
  return `knowscroll-export-${result.exportedAt.replace(/[^0-9A-Za-z]/g, '-')}.json`;
}

function ExportSection({ action, onExport }: { action: PrivacyActionState; onExport: () => void }) {
  const pending = action.status === 'pending' && action.kind === 'export';
  const failed = action.status === 'failed' && action.kind === 'export' ? action : null;
  const ready = action.status === 'export-ready' ? action : null;

  return (
    <section className="privacy-section">
      <p className="eyebrow">Export</p>
      <h2>Take your data</h2>
      <p>
        Requests everything this universe has recorded about you — every exposure, keep and Ask, your saved Traces,
        your device sessions (never their secret tokens), and what reasoning ran and its recorded cost — and gives it
        to you as a file. It does not change anything recorded.
      </p>
      {failed && (
        <p className="privacy-error" role="alert">
          {failed.message}
        </p>
      )}
      {ready ? (
        <div className="privacy-export-ready">
          <p className="privacy-export-summary">
            {ready.result.rowCounts.ledger} recorded events · {ready.result.rowCounts.decisions} feed decisions ·{' '}
            {ready.result.rowCounts.deviceSessions} device sessions
          </p>
          <a className="pill teal" href={exportDownloadHref(ready.result)} download={exportFileName(ready.result)} aria-label="Download your export">
            Download export
          </a>
        </div>
      ) : (
        <button type="button" className="pill teal" disabled={pending} onClick={onExport} aria-label={failed ? 'Retry export' : 'Take your data'}>
          {failed ? 'Retry' : pending ? 'Preparing…' : 'Take your data'}
        </button>
      )}
    </section>
  );
}

function ResetSection({
  action,
  onBeginReset,
  onCancelReset,
  onConfirmReset,
}: {
  action: PrivacyActionState;
  onBeginReset: () => void;
  onCancelReset: () => void;
  onConfirmReset: (typed: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const confirming = action.status === 'confirming-reset';
  const pending = action.status === 'pending' && action.kind === 'reset';
  const failed = action.status === 'failed' && action.kind === 'reset' ? action : null;

  if (!confirming && !pending && !failed) {
    return (
      <section className="privacy-section">
        <p className="eyebrow">Reset</p>
        <h2>Reset your universe</h2>
        <p>Erases everything this universe has recorded and signs every device out, including this one. It cannot be undone.</p>
        <button type="button" className="pill orange" onClick={onBeginReset} aria-label="Reset your universe">
          Reset your universe
        </button>
      </section>
    );
  }

  return (
    <section className="privacy-section privacy-reset-confirm">
      <p className="eyebrow">Reset</p>
      <h2>Reset your universe</h2>
      <p>
        Erases every exposure, keep and Ask this universe has recorded, and every saved Trace, then signs every
        device out, including this one. It cannot be undone.
      </p>
      {failed && (
        <p className="privacy-error" role="alert">
          {failed.message}
        </p>
      )}
      <label className="privacy-confirm-label" htmlFor="privacy-reset-confirm-input">
        Type {RESET_CONFIRMATION} to confirm
      </label>
      <input
        id="privacy-reset-confirm-input"
        className="privacy-confirm-input"
        type="text"
        value={typed}
        onChange={event => setTyped(event.target.value)}
        disabled={pending}
        autoComplete="off"
        spellCheck={false}
      />
      <div className="privacy-reset-actions">
        <button type="button" className="pill cream" onClick={onCancelReset} disabled={pending} aria-label="Cancel reset">
          Cancel
        </button>
        <button
          type="button"
          className="pill orange"
          disabled={pending || typed !== RESET_CONFIRMATION}
          onClick={() => onConfirmReset(typed)}
          aria-label="Confirm reset"
        >
          {pending ? 'Resetting…' : 'Confirm reset'}
        </button>
      </div>
    </section>
  );
}

/** #135, ADR-0034: no confirmation step (unlike Reset/Delete account below) -- ending this session
 * destroys nothing recorded, so it follows RecordingSection's pattern rather than ResetSection's. */
function SignOutSection({ action, onSignOut }: { action: PrivacyActionState; onSignOut: () => void }) {
  const pending = action.status === 'pending' && action.kind === 'sign-out';
  const failed = action.status === 'failed' && action.kind === 'sign-out' ? action : null;

  return (
    <section className="privacy-section">
      <p className="eyebrow">Sign out</p>
      <h2>Sign out of this browser</h2>
      <p>Ends this browser's session. Your account and recorded history are untouched -- sign back in any time.</p>
      {failed && (
        <p className="privacy-error" role="alert">
          {failed.message}
        </p>
      )}
      <button type="button" className="pill cream" aria-label={failed ? 'Retry sign out' : 'Sign out'} disabled={pending} onClick={onSignOut}>
        {failed ? 'Retry' : pending ? 'Signing out…' : 'Sign out'}
      </button>
    </section>
  );
}

/**
 * #135, ADR-0035: the one truly irreversible action here (more than Reset: the account, its
 * sessions, sign-in tokens and dated privacy receipts are gone too, not merely the recorded
 * history). Mirrors ResetSection's typed-confirmation shape, but the word the reader types
 * (`ACCOUNT_DELETE_TYPED_WORD`, short and legible) deliberately differs from the longer wire
 * literal `confirmDeleteAccount` actually sends -- the reader is never asked to type that verbatim.
 */
function DeleteAccountSection({
  action,
  onBeginDeleteAccount,
  onCancelDeleteAccount,
  onConfirmDeleteAccount,
}: {
  action: PrivacyActionState;
  onBeginDeleteAccount: () => void;
  onCancelDeleteAccount: () => void;
  onConfirmDeleteAccount: (typed: string) => void;
}) {
  const [typed, setTyped] = useState('');
  const confirming = action.status === 'confirming-delete';
  const pending = action.status === 'pending' && action.kind === 'delete-account';
  const failed = action.status === 'failed' && action.kind === 'delete-account' ? action : null;

  if (!confirming && !pending && !failed) {
    return (
      <section className="privacy-section">
        <p className="eyebrow">Delete account</p>
        <h2>Delete your account</h2>
        <p>Removes your account, all recorded history, your sessions, sign-in links and privacy receipts. The universe starts empty the next time you sign in. This is permanent.</p>
        <button type="button" className="pill orange" onClick={onBeginDeleteAccount} aria-label="Delete account">
          Delete account
        </button>
      </section>
    );
  }

  return (
    <section className="privacy-section privacy-reset-confirm">
      <p className="eyebrow">Delete account</p>
      <h2>Delete your account</h2>
      <p>Removes your account, all recorded history, your sessions, sign-in links and privacy receipts. The universe starts empty the next time you sign in. This is permanent.</p>
      {failed && (
        <p className="privacy-error" role="alert">
          {failed.message}
        </p>
      )}
      <label className="privacy-confirm-label" htmlFor="privacy-delete-account-confirm-input">
        Type {ACCOUNT_DELETE_TYPED_WORD} to confirm
      </label>
      <input
        id="privacy-delete-account-confirm-input"
        className="privacy-confirm-input"
        type="text"
        value={typed}
        onChange={event => setTyped(event.target.value)}
        disabled={pending}
        autoComplete="off"
        spellCheck={false}
      />
      <div className="privacy-reset-actions">
        <button type="button" className="pill cream" onClick={onCancelDeleteAccount} disabled={pending} aria-label="Cancel delete account">
          Cancel
        </button>
        <button
          type="button"
          className="pill orange"
          disabled={pending || typed !== ACCOUNT_DELETE_TYPED_WORD}
          onClick={() => onConfirmDeleteAccount(typed)}
          aria-label="Delete my account"
        >
          {pending ? 'Deleting…' : 'Delete my account'}
        </button>
      </div>
    </section>
  );
}

function ResetComplete({ receipt, onAcknowledgeReset }: { receipt: PrivacyResetReceipt; onAcknowledgeReset: () => void }) {
  return (
    <section className="privacy-section privacy-reset-complete" role="status" aria-live="polite">
      <p className="eyebrow">Reset complete</p>
      <h2>Your universe was reset</h2>
      <dl className="privacy-receipt">
        <dt>Privacy epoch</dt>
        <dd>{`${receipt.epochBefore} → ${receipt.epochAfter}`}</dd>
        <dt>Sessions ended</dt>
        <dd>{receipt.sessionsRevoked}</dd>
        <dt>When</dt>
        <dd>{formatTimestamp(receipt.resetAt)}</dd>
      </dl>
      <p>
        Every exposure, keep and Ask this universe had recorded is erased. Every device that was signed in, including
        this one, is signed out now — continuing will show that plainly.
      </p>
      <button type="button" className="pill teal" onClick={onAcknowledgeReset} aria-label="Continue">
        Continue
      </button>
    </section>
  );
}

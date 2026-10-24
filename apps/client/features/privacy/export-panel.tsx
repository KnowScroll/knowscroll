import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { View } from 'react-native';
import { createDataExportsSession } from '@knowscroll/client-core';
import type { DataExportSummary } from '@knowscroll/contracts';
import { content, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Skeleton, Text } from '@knowscroll/ui';
import { newCommandId } from '../../platform/command-id';
import { openExportDownload } from '../../platform/export-download';
import { useAccountScope } from '../../providers/account-scope';
import { ReceiptCard, SettingsLabel } from '../account/settings-parts';

/** How often a preparing export is asked about. */
const POLL_MS = 4_000;

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });

/**
 * P02 "History & export": ask for a copy of your own data and keep the receipts. The file holds
 * what is yours (your encounters, saved items, requests, universe and sharing profile) and nothing
 * of anyone else. A download works once; after that, or after a week, ask again.
 */
export function ExportPanel({ compact = false }: { readonly compact?: boolean }) {
  const { state: account } = useAccountScope();
  if (account.status !== 'signed_in') return <Text variant="bodyS">Sign in to download a copy of your data.</Text>;
  return <SignedInExports scope={account.scope} compact={compact} />;
}

function SignedInExports({
  scope,
  compact,
}: {
  readonly scope: Extract<ReturnType<typeof useAccountScope>['state'], { status: 'signed_in' }>['scope'];
  readonly compact: boolean;
}) {
  const session = useMemo(() => createDataExportsSession(scope, newCommandId), [scope]);
  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  useEffect(() => {
    void session.refresh();
  }, [session]);
  const preparing = state.exports.some((entry) => entry.state === 'preparing');
  useEffect(() => {
    if (!preparing) return undefined;
    const timer = setInterval(() => void session.refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [session, preparing]);
  return (
    <View style={{ gap: spacing[4] }}>
      <Text variant={compact ? 'bodyS' : 'body'}>
        A copy of your encounters, saved items, requests, the places in your universe and your sharing profile. It holds
        nothing of anyone else.
      </Text>
      <View style={{ alignItems: 'flex-start' }}>
        <Button
          label="Request a new export"
          variant="primary"
          busy={state.requesting}
          busyLabel="Requesting…"
          disabled={preparing || state.status === 'unavailable'}
          onPress={() => void session.request()}
        />
      </View>
      {state.failed === 'request' ? (
        <Banner kind="error" lead="Couldn't ask for an export." message="Nothing was sent. Try again." />
      ) : null}
      {state.failed === 'download' ? (
        <Banner kind="error" lead="Couldn't start the download." message="Try again, or ask for a new export." />
      ) : null}
      <SettingsLabel>Your exports</SettingsLabel>
      {state.status === 'loading' ? <Skeleton rows={1} label="Loading your exports" /> : null}
      {state.status === 'unavailable' ? (
        <Banner
          kind="offline"
          lead="Can't load your exports."
          message="Check your connection."
          action={{ label: 'Retry', onPress: () => void session.refresh() }}
        />
      ) : null}
      {state.status === 'ready' && state.exports.length === 0 ? (
        <Text variant="meta" color={content.ink2}>
          No exports yet.
        </Text>
      ) : null}
      {state.exports.map((entry) => (
        <ExportReceipt
          key={entry.id}
          entry={entry}
          opening={state.opening === entry.id}
          onDownload={() => void session.download(entry.id, openExportDownload)}
          onRetry={() => void session.request()}
          retryDisabled={preparing || state.requesting}
        />
      ))}
    </View>
  );
}

function ExportReceipt({
  entry,
  opening,
  onDownload,
  onRetry,
  retryDisabled,
}: {
  readonly entry: DataExportSummary;
  readonly opening: boolean;
  readonly onDownload: () => void;
  readonly onRetry: () => void;
  readonly retryDisabled: boolean;
}) {
  const when = day(entry.requestedAt);
  switch (entry.state) {
    case 'preparing':
      return (
        <ReceiptCard tone="preparing" state="Preparing" when={when}>
          <Text variant="meta" color={content.ink2}>
            History, Keep and messages. It shows here when it's ready.
          </Text>
        </ReceiptCard>
      );
    case 'ready':
      return (
        <ReceiptCard
          tone="done"
          state="Ready"
          when={when}
          action={<Button label="Download" size="sm" busy={opening} busyLabel="Preparing link…" onPress={onDownload} />}
        >
          <Text variant="meta" color={content.ink2}>
            {entry.expiresAt === null ? 'Ready to download.' : `Available until ${day(entry.expiresAt)}.`} The download
            works once.
          </Text>
        </ReceiptCard>
      );
    case 'downloaded':
      return (
        <ReceiptCard tone="done" state="Downloaded" when={when}>
          <Text variant="meta" color={content.ink2}>
            Downloaded and removed from our servers. Ask for a new export for another copy.
          </Text>
        </ReceiptCard>
      );
    case 'expired':
      return (
        <ReceiptCard tone="failed" state="Expired" when={when}>
          <Text variant="meta" color={content.ink2}>
            This export is no longer available. Ask for a new one.
          </Text>
        </ReceiptCard>
      );
    case 'failed':
      return (
        <ReceiptCard
          tone="failed"
          state="Failed"
          when={when}
          action={<Button label="Retry" size="sm" disabled={retryDisabled} onPress={onRetry} />}
        >
          <Text variant="meta" color={content.ink2}>
            We couldn't finish this export. Nothing was sent anywhere.
          </Text>
        </ReceiptCard>
      );
  }
}

import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { apiProblem, healthQueryOptions, type AccountScope } from '@knowscroll/client-core';
import { borderWidth, content, layer, radius, spacing } from '@knowscroll/design-tokens';
import { Text } from '@knowscroll/ui';

/** The worlds that have operator tools (the API's `OPERATOR_WORLDS`): never live, whatever it is called. */
const OPERATOR_WORLDS: readonly string[] = ['dev', 'stage', 'ci', 'local'];

/** Re-reads the durable state this often while the panel is on screen, so a lost hint costs nothing. */
const BOUNDED_REFRESH_MS = 10_000;

function Row({ name, value, testID }: { readonly name: string; readonly value: string; readonly testID?: string }) {
  return (
    <View style={styles.row}>
      <Text variant="meta" color={content.ink2}>
        {name}
      </Text>
      <Text variant="meta" selectable testID={testID}>
        {value}
      </Text>
    </View>
  );
}

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}

/**
 * DEV-ONLY diagnostics for the thin journey (#229): the committed evidence watermark and revision of
 * the exposure being read. An operator surface, never consumer UI (blueprint §26; the consumer UI
 * never shows scores): it renders only when `GET /health` names a world with operator tools (dev,
 * stage, ci, local), and the API answers its route with 404 in every other world, so a production
 * build shows nothing even if this component were mounted.
 *
 * It reads durable state. The scope's socket marks every scoped query stale when a `scope_changed`
 * hint arrives (the evidence commit sends one), so the view catches up by refetching; a bounded
 * refresh covers a hint that was lost. The universe revision it shows is the watermark that a hint
 * is compared with: after the evidence commit it is one higher than before.
 */
export function OperatorEvidencePanel({
  scope,
  exposureId,
}: {
  readonly scope: AccountScope;
  readonly exposureId: string;
}) {
  const [open, setOpen] = useState(false);
  const health = useQuery({ ...healthQueryOptions(scope.api), retry: false });
  const operatorWorld = health.data !== undefined && OPERATOR_WORLDS.includes(health.data.world);
  const diagnostics = useQuery({
    queryKey: scope.queryKey('diagnostics', 'evidence', exposureId),
    queryFn: () => scope.api.diagnostics.evidence({ exposureId }),
    enabled: operatorWorld,
    refetchInterval: BOUNDED_REFRESH_MS,
    retry: false,
  });
  if (!operatorWorld) return null;
  const data = diagnostics.data;
  const evidence = data?.evidence ?? null;
  const summary =
    diagnostics.isError && apiProblem(diagnostics.error)?.code === 'NOT_FOUND'
      ? 'not available here'
      : evidence === null
        ? `no evidence yet · ${String(data?.observations.count ?? 0)} observations`
        : `rev ${String(evidence.revision)} · ${evidence.qualification} · q ${evidence.q.toFixed(2)}`;
  return (
    <View style={styles.dock} testID="ks-dev-evidence" pointerEvents="box-none">
      <View style={styles.panel}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel="Developer diagnostics: evidence"
          onPress={() => setOpen((value) => !value)}
          style={styles.head}
        >
          <Text variant="label" color={content.ink2}>
            Dev · evidence
          </Text>
          <Text variant="meta" testID="ks-dev-evidence-summary">
            {summary}
          </Text>
        </Pressable>
        {open && data !== undefined ? (
          <View style={styles.body}>
            <Row name="Universe revision" value={String(data.revision)} testID="ks-dev-universe-revision" />
            <Row name="Observations stored" value={String(data.observations.count)} testID="ks-dev-observations" />
            {evidence === null ? (
              <Row name="Evidence" value="none committed yet" />
            ) : (
              <>
                <Row name="Evidence revision" value={String(evidence.revision)} testID="ks-dev-evidence-revision" />
                <Row name="Input watermark" value={String(evidence.inputWatermark)} />
                <Row name="Qualification" value={evidence.qualification} testID="ks-dev-qualification" />
                <Row name="q" value={evidence.q.toFixed(4)} />
                <Row name="Coverage" value={evidence.coverage.toFixed(4)} />
                <Row
                  name="Active dwell"
                  value={`${seconds(evidence.activeDwellMs)} of ${seconds(evidence.estimatedReadingMs)} estimated`}
                />
                <Row name="Policy" value={evidence.policyVersion} />
              </>
            )}
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  dock: { position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: layer.topBar, alignItems: 'center' },
  panel: {
    width: '100%',
    maxWidth: 560,
    borderTopLeftRadius: radius.card,
    borderTopRightRadius: radius.card,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper2,
    padding: spacing[3],
    gap: spacing[2],
  },
  head: { gap: spacing['0.5'], minHeight: 44, justifyContent: 'center' },
  body: { gap: spacing[1] },
  row: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing[3] },
});

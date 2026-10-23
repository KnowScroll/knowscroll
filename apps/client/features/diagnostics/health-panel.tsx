import { useQuery } from '@tanstack/react-query';
import { useMemo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { apiProblem, healthQueryOptions, type ApiClient } from '@knowscroll/client-core';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Banner, Button, Text } from '@knowscroll/ui';
import { appApiClient } from '../../platform/api';

function Row({ name, value }: { name: string; value: string }) {
  return (
    <View style={styles.row}>
      <Text variant="label" color={content.ink2}>
        {name}
      </Text>
      <Text variant="meta" selectable>
        {value}
      </Text>
    </View>
  );
}

function Panel({ children }: { children: ReactNode }) {
  return (
    <View style={styles.panel} testID="health-panel">
      <Text variant="title" heading={2}>
        API health
      </Text>
      {children}
    </View>
  );
}

function HealthAnswer({ api }: { api: ApiClient }) {
  const health = useQuery(healthQueryOptions(api));
  if (health.isPending) return <Text variant="meta">Asking GET /health…</Text>;
  if (health.isError) {
    return (
      <Banner
        kind="error"
        lead="GET /health failed."
        message={apiProblem(health.error)?.title ?? 'The API did not answer.'}
        action={{ label: 'Retry', onPress: () => void health.refetch() }}
      />
    );
  }
  return (
    <>
      <Row name="World" value={health.data.world} />
      <Row name="Commit" value={health.data.commit} />
      <Row name="Artifact" value={health.data.artifact} />
      <Row name="Migration" value={health.data.migration} />
      <Row name="Relay" value={health.data.relay} />
      <Button
        label="Ask again"
        size="sm"
        onPress={() => void health.refetch()}
        busy={health.isFetching}
        busyLabel="Asking"
      />
    </>
  );
}

/**
 * Developer diagnostics: which API this build talks to and what `GET /health` answers (world,
 * commit, artifact, newest migration). Shown only in the dev gallery, never in consumer UI.
 */
export function HealthPanel() {
  const client = useMemo(() => appApiClient(), []);
  if (!client.ok) {
    return (
      <Panel>
        <Banner kind="error" lead="No API origin." message={`This build cannot reach an API (${client.reason}).`} />
      </Panel>
    );
  }
  return (
    <Panel>
      <Row name="API origin" value={client.baseUrl} />
      <HealthAnswer api={client.api} />
    </Panel>
  );
}

const styles = StyleSheet.create({
  panel: {
    gap: spacing[3],
    padding: spacing[5],
    borderRadius: radius.panel,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  row: { gap: spacing[1] },
});

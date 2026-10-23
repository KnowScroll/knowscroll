/** ks-native-durability-screen-v1 — synthetic CI SDK evidence only, never a consumer page. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { Button, Text, View } from 'react-native';
import { useAccountScope } from '../../providers/account-scope';
import { nativeDurabilityBootstrap, type NativeBootstrap } from './native-durability-bootstrap';

export function NativeDurabilityScreen() {
  const { state, manager } = useAccountScope();
  const [bootstrap, setBootstrap] = useState<NativeBootstrap>();
  useEffect(() => {
    void nativeDurabilityBootstrap().then(setBootstrap);
  }, []);
  const harness = bootstrap?.kind === 'ready' ? bootstrap.harness : undefined;
  const receipt = useSyncExternalStore(
    harness?.subscribe ?? noSubscription,
    harness?.getState ?? initial,
    harness?.getState ?? initial,
  );
  useEffect(() => {
    if (!harness || harness.manager !== manager) return;
    if (state.status === 'signed_in' && receipt.phase === 'starting') void harness.mounted(state.scope);
    if (state.status === 'unavailable' && receipt.phase === 'starting') void harness.sqliteUnavailable();
  }, [harness, manager, state, receipt.phase]);
  return (
    <View style={{ padding: 24, gap: 16 }}>
      <Text>CI fixture · actual native SDK, synthetic auth and HTTP. No real-service or physical-device claim.</Text>
      <Text testID="ks-native-durability-screen-v1">Native scoped durability</Text>
      <Text testID={bootstrap?.kind === 'ready' ? bootstrap.marker : 'native249-no-bootstrap'}>
        Single native owner
      </Text>
      <Text testID={`native249-${receipt.phase}`}>{receipt.phase}</Text>
      <Text>{`checks=${receipt.checks}; fixture requests=${receipt.fixtureRequests}`}</Text>
      {harness && state.status === 'signed_in' && receipt.phase === 'restored-ready' ? (
        <Button
          testID="native249-complete-pending"
          title="Acknowledge original fixture work"
          onPress={() => {
            void harness.completePending(state.scope);
          }}
        />
      ) : null}
      {harness && state.status === 'signed_in' && receipt.phase === 'acked-ready' ? (
        <Button
          testID="native249-fail-closed"
          title="Attempt faulted cleanup"
          onPress={() => {
            void harness.failClosed(state.scope);
          }}
        />
      ) : null}
      {harness && receipt.phase === 'secure-failed-commit' ? (
        <Button
          testID="native249-retry-cleanup"
          title="Retry after permission restoration"
          onPress={() => {
            void harness.retryCleanup();
          }}
        />
      ) : null}
    </View>
  );
}
const noSubscription = () => () => undefined;
const starting = { phase: 'starting' as const, checks: 0, fixtureRequests: 0 };
const initial = () => starting;

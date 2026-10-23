import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ComponentRef,
} from 'react';
import { AppState, Dimensions, Platform, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import type { AccountScope } from '@knowscroll/client-core';

type Box = { left: number; top: number; right: number; bottom: number };
type Snapshot = { revision: number; bounds: Box | null };
export function createReelViewport() {
  let current: Snapshot = { revision: 0, bounds: null };
  const listeners = new Set<() => void>();
  return {
    read: () => current,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    invalidate() {
      current = { revision: current.revision + 1, bounds: null };
      for (const listener of listeners) listener();
      return current.revision;
    },
    measured(revision: number, bounds: Box | null) {
      if (current.revision !== revision) return;
      current = { revision, bounds };
      for (const listener of listeners) listener();
    },
  };
}
const Viewport = createContext<{ store: ReturnType<typeof createReelViewport>; stageMaxHeight: number } | null>(null);
function box(x: number, y: number, width: number, height: number): Box | null {
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0
    ? { left: x, top: y, right: x + width, bottom: y + height }
    : null;
}

/** A measured native viewport; safe areas/tab exclusion belong outside its measured inner View.
 * Web retains the player's existing clipping-aware IntersectionObserver. No player is keyed by geometry. */
export function ReelPage({
  children,
  testID,
  topInset = 0,
  bottomInset = 0,
  leftInset = 0,
  rightInset = 0,
}: {
  readonly children: ReactNode;
  readonly testID: string;
  readonly topInset?: number;
  readonly bottomInset?: number;
  readonly leftInset?: number;
  readonly rightInset?: number;
}) {
  const store = useMemo(() => createReelViewport(), []);
  const viewport = useRef<ComponentRef<typeof View>>(null);
  const { width, height } = useWindowDimensions();
  const mounted = useRef(false);
  const [measuredHeight, setMeasuredHeight] = useState(0);
  const context = useMemo(
    () => ({ store, stageMaxHeight: measuredHeight > 0 ? measuredHeight / 2 : 160 }),
    [store, measuredHeight],
  );
  const measure = useCallback(() => {
    // Subscribers synchronously pause and revoke their old observation before asynchronous measurement.
    const revision = store.invalidate();
    try {
      viewport.current?.measureInWindow((x, y, w, h) => {
        if (!mounted.current || store.read().revision !== revision) return;
        const measured = box(x, y, w, h),
          window = Dimensions.get('window');
        const clipped = measured
          ? {
              left: Math.max(0, measured.left),
              top: Math.max(0, measured.top),
              right: Math.min(window.width, measured.right),
              bottom: Math.min(window.height, measured.bottom),
            }
          : null;
        const valid = clipped && clipped.right > clipped.left && clipped.bottom > clipped.top ? clipped : null;
        store.measured(revision, valid);
        if (store.read().revision === revision) setMeasuredHeight(valid ? valid.bottom - valid.top : 0);
      });
    } catch {
      store.measured(revision, null);
    }
  }, [store]);
  useLayoutEffect(() => {
    mounted.current = true;
    measure();
    return () => {
      mounted.current = false;
      store.invalidate();
    };
  }, [store, measure]);
  useLayoutEffect(measure, [measure, width, height, topInset, bottomInset, leftInset, rightInset]);
  return (
    <Viewport.Provider value={context}>
      <View
        style={[
          styles.fill,
          { paddingTop: topInset, paddingBottom: bottomInset, paddingLeft: leftInset, paddingRight: rightInset },
        ]}
      >
        <View ref={viewport} testID={testID} style={styles.fill} onLayout={measure}>
          <ScrollView
            testID={`${testID}-scroll`}
            style={styles.fill}
            contentContainerStyle={styles.content}
            onScroll={measure}
            onScrollBeginDrag={measure}
            onContentSizeChange={measure}
            scrollEventThrottle={16}
          >
            {children}
          </ScrollView>
        </View>
      </View>
    </Viewport.Provider>
  );
}

/** Internal native geometry observer, shared by the actual hook and deterministic Actions races. */
export function observeReelPageStage(
  store: ReturnType<typeof createReelViewport>,
  scope: AccountScope,
  enabled: boolean,
  pause: () => void,
  measureStage: (callback: (x: number, y: number, width: number, height: number) => void) => void,
  changed: (visible: boolean) => void,
  resume?: {
    invalidated(): void;
    status(status: 'pending' | 'visible' | 'hidden'): void;
  },
) {
  let foreground = AppState.currentState === 'active';
  let alive = true,
    ticket = 0,
    seen = -1;
  let pendingMeasurement: number | undefined;
  const invalidate = (genuine = true, pending = true) => {
    ticket += 1;
    pendingMeasurement = undefined;
    pause();
    if (genuine) resume?.invalidated();
    if (alive) {
      changed(false);
      resume?.status(pending ? 'pending' : 'hidden');
    }
  };
  const measure = () => {
    const current = store.read();
    if (seen !== current.revision) {
      const firstBinding = seen === -1;
      seen = current.revision;
      invalidate(!firstBinding);
    }
    if (!alive || !enabled || !scope.active || !foreground || !current.bounds) {
      if (alive && (!enabled || !scope.active || !foreground)) resume?.status('hidden');
      return;
    }
    // A close can wait for this exact native callback only. Replacing an outstanding measure
    // cancels that request rather than moving it into a newer geometry generation.
    if (pendingMeasurement !== undefined) resume?.invalidated();
    const sequence = ++ticket;
    pendingMeasurement = sequence;
    try {
      measureStage((x, y, w, h) => {
        if (!alive || sequence !== ticket || !scope.active || !foreground || store.read().revision !== current.revision)
          return;
        pendingMeasurement = undefined;
        const stage = box(x, y, w, h),
          v = current.bounds!;
        const area = stage
          ? Math.max(0, Math.min(stage.right, v.right) - Math.max(stage.left, v.left)) *
            Math.max(0, Math.min(stage.bottom, v.bottom) - Math.max(stage.top, v.top))
          : 0;
        const visible = stage !== null && area / (w * h) >= 0.5;
        if (!visible) {
          pause();
          resume?.invalidated();
        }
        changed(visible);
        resume?.status(visible ? 'visible' : 'hidden');
      });
    } catch {
      invalidate(true, false);
    }
  };
  const unsubscribe = store.subscribe(measure);
  const ended = scope.onEnd?.(() => {
    invalidate();
    alive = false;
    unsubscribe();
  });
  const activity = AppState.addEventListener('change', (value) => {
    foreground = value === 'active';
    invalidate();
    measure();
  });
  invalidate(false);
  measure();
  return {
    layout: () => {
      invalidate();
      measure();
    },
    stop: () => {
      alive = false;
      ticket += 1;
      pause();
      unsubscribe();
      ended?.();
      activity.remove();
    },
  };
}

/** Native visibility is tied to this mounted stage and current account lifetime. Old layout callbacks
 * cannot restore playback permission after a scroll/resize, route park, background or scope end. */
export function useReelPageStage(scope: AccountScope, enabled: boolean, pause: () => void, cancelResume?: () => void) {
  const viewport = useContext(Viewport);
  const store = viewport?.store ?? null;
  const ref = useRef<ComponentRef<typeof View>>(null);
  const binding = useMemo(() => ({ scope, enabled, store }), [scope, enabled, store]);
  const [observation, setObservation] = useState<{
    binding: typeof binding;
    status: 'pending' | 'visible' | 'hidden';
  }>();
  const request = useRef<() => void>(() => undefined);
  useLayoutEffect(() => {
    if (Platform.OS === 'web' || !store) return;
    const observer = observeReelPageStage(
      store,
      scope,
      enabled,
      pause,
      (callback) => ref.current?.measureInWindow(callback),
      () => undefined,
      {
        invalidated: () => cancelResume?.(),
        status: (status) => setObservation({ binding, status }),
      },
    );
    request.current = observer.layout;
    return () => {
      observer.stop();
      request.current = () => undefined;
    };
  }, [binding, scope, enabled, pause, store, cancelResume]);
  const status =
    Platform.OS === 'web' || !store
      ? enabled && scope.active
        ? 'visible'
        : 'hidden'
      : !enabled || !scope.active
        ? 'hidden'
        : observation?.binding === binding
          ? observation.status
          : 'pending';
  return {
    ref,
    stageMaxHeight: viewport?.stageMaxHeight,
    onLayout: useCallback(() => request.current(), []),
    visible: status === 'visible',
    status,
  };
}
const styles = StyleSheet.create({ fill: { flex: 1, minHeight: 0 }, content: { flexGrow: 1 } });

import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { PanResponder, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { space, spacing } from '@knowscroll/design-tokens';
import { Text, useDisplay } from '@knowscroll/ui';
import { useDocumentTitle } from '../../platform/document-title';
import { seededRandom } from '../universe/space/paint';
import { AllFriendsChip, AllFriendsSheet } from '../universe/voyage/outer/all-friends-list';
import { clampPan, type Point } from '../universe/voyage/outer/friend-field';
import { OuterLayer } from '../universe/voyage/outer/outer-layer';
import { sampleFriends } from './outer-gallery-fixtures';
import { readOuterParams } from './outer-gallery-params';

/** The sample sky: a few hundred fixed points of starlight, so the layer is seen over something dark and not flat. */
function Sky({ width, height }: { readonly width: number; readonly height: number }) {
  const stars = useMemo(() => {
    const next = seededRandom('outer-gallery-sky');
    return Array.from({ length: 140 }, () => ({
      x: next() * width,
      y: next() * height,
      r: 0.4 + next() * 0.7,
      a: 0.25 + next() * 0.5,
    }));
  }, [width, height]);
  return (
    <Svg width={width} height={height} style={StyleSheet.absoluteFill} pointerEvents="none">
      {stars.map((star, index) => (
        <Circle key={index} cx={star.x} cy={star.y} r={star.r} fill="#FFFDF2" fillOpacity={star.a} />
      ))}
    </Svg>
  );
}

/**
 * `?scene=outer` of the developer space gallery: the outer stop's layer (`OuterLayer`) and its list of all friends over a
 * dark sky, with a fixed place for your universe and labelled sample friends (never people). It is how the layer is
 * seen until it is wired into the Universe. Drag the sky to pan the field; a tap on a friend only says who it would cross to.
 *
 * `friends=0..200`, `panx`, `pany` (px), `status=ready|loading|offline|failed`, `buttons=0`, `list=1`, `web=0`.
 */
export function OuterGalleryPage() {
  useDocumentTitle('Beyond your universe · KnowScroll');
  const insets = useSafeAreaInsets();
  const { reducedMotion } = useDisplay();
  const raw = useLocalSearchParams<Record<string, string>>();
  const params = readOuterParams(raw);
  const friends = useMemo(() => sampleFriends(params.friends), [params.friends]);
  const [size, setSize] = useState({ width: 390, height: 844 });
  const onLayout = (event: LayoutChangeEvent): void => {
    const { width, height } = event.nativeEvent.layout;
    if (width > 0 && height > 0) setSize({ width, height });
  };
  const universe = useMemo(
    () => ({ x: size.width * 0.56, y: size.height * 0.486, radiusPx: 0.13 * Math.min(size.width, 460), fade: 1 }),
    [size],
  );
  // The field's offset is where the last drag left it (`base`) plus the drag in progress (`move`); it is held where the
  // field still shows friends, as the Universe will hold it.
  const [drag, setDrag] = useState<{ readonly base: Point; readonly move: Point }>(() => ({
    base: { x: params.panX, y: params.panY },
    move: { x: 0, y: 0 },
  }));
  const [listOpen, setListOpen] = useState(params.list);
  const [last, setLast] = useState('');
  const field = useMemo(() => ({ viewport: size, universe }), [size, universe]);
  const held = useMemo(
    () => clampPan(friends, field, { x: drag.base.x + drag.move.x, y: drag.base.y + drag.move.y }),
    [friends, field, drag],
  );
  const responder = useMemo(() => {
    const settle = (): void =>
      setDrag((now) => ({
        base: clampPan(friends, field, { x: now.base.x + now.move.x, y: now.base.y + now.move.y }),
        move: { x: 0, y: 0 },
      }));
    return PanResponder.create({
      onMoveShouldSetPanResponder: (_event, gesture) => Math.hypot(gesture.dx, gesture.dy) > 6,
      onPanResponderMove: (_event, gesture) =>
        setDrag((now) => ({ base: now.base, move: { x: gesture.dx, y: gesture.dy } })),
      onPanResponderRelease: settle,
      onPanResponderTerminate: settle,
    });
  }, [friends, field]);
  const cross = (handle: string): void => setLast(`Cross to ${handle}`);
  return (
    <View style={styles.page} onLayout={onLayout} {...responder.panHandlers}>
      <Sky width={size.width} height={size.height} />
      <OuterLayer
        universe={universe}
        pan={held}
        friends={friends}
        viewport={size}
        buttonsLive={params.buttons}
        reducedMotion={reducedMotion}
        onCross={cross}
        status={params.status}
        onRetry={() => setLast('Try again')}
        ownWeb={params.web}
      />
      <View pointerEvents="none" style={[styles.note, { top: insets.top + spacing[3] }]}>
        <Text variant="label" color={space.label2}>
          Gallery · sample friends, not yours · drag to pan
        </Text>
      </View>
      <View style={[styles.chip, { bottom: spacing[6] + insets.bottom }]}>
        <AllFriendsChip count={friends.length} status={params.status} onPress={() => setListOpen(true)} />
      </View>
      <AllFriendsSheet
        visible={listOpen}
        friends={friends}
        status={params.status}
        onClose={() => setListOpen(false)}
        onCross={cross}
        onRetry={() => setLast('Try again')}
      />
      <View accessibilityLabel={last} testID="ks-outer-last" pointerEvents="none" style={styles.last} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: space.s0 },
  note: { position: 'absolute', left: spacing[4], right: spacing[4] },
  chip: { position: 'absolute', left: spacing[4], flexDirection: 'row' },
  last: { position: 'absolute', left: 0, top: 0, width: 1, height: 1 },
});

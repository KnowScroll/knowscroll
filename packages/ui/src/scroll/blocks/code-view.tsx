import { useEffect, useRef, useState } from 'react';
import type { setStringAsync as SetString } from 'expo-clipboard';
import {
  ScrollView,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { borderWidth, content, overlay, radius, space, spacing } from '@knowscroll/design-tokens';
import type { BlockOfType } from '@knowscroll/scroll-model';
import { Button } from '../../actions/button';
import { useDisplay } from '../../display/display';
import { Text } from '../../text/text';
import { codeType } from '../code-style';
import { useScrollRender } from '../context';
import { blockAttributes } from '../data-attributes';

const LANGUAGE_LABELS = {
  python: 'Python',
  javascript: 'JavaScript',
  typescript: 'TypeScript',
  sql: 'SQL',
  shell: 'Shell',
  json: 'JSON',
  rust: 'Rust',
  go: 'Go',
  java: 'Java',
  kotlin: 'Kotlin',
  swift: 'Swift',
  c: 'C',
  cpp: 'C++',
  csharp: 'C#',
  r: 'R',
  text: 'Text',
} as const;

/** How long the button says "Copied" before it goes back to "Copy". */
const COPIED_MS = 2000;

/**
 * Source code, shown and never run. It scrolls horizontally inside its own frame (a long line
 * never widens the article), so the block owns a locked horizontal drag; the scroller is focusable
 * on the web so the keyboard can move it.
 */
export function CodeView({ block }: { readonly block: BlockOfType<'code'> }) {
  const context = useScrollRender();
  const { textScale } = useDisplay();
  const type = codeType(textScale);
  const [outcome, setOutcome] = useState<'idle' | 'copied' | 'failed'>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );
  const [metrics, setMetrics] = useState({ offset: 0, content: 0, view: 0 });
  const highlighted = new Set(block.data.highlightLines);
  const lines = block.data.code.split('\n');
  const language = LANGUAGE_LABELS[block.data.language];
  const title = block.data.title === undefined ? language : `${language} · ${block.data.title}`;

  const copy = async () => {
    context.report(block.id, 'copy');
    let next: 'copied' | 'failed' = 'copied';
    try {
      // Loaded when it is needed: no native clipboard module is touched until a reader copies.
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- a lazy require keeps the native module out of every import of this package
      const { setStringAsync } = require('expo-clipboard') as { setStringAsync: typeof SetString };
      await setStringAsync(block.data.code);
    } catch {
      next = 'failed';
    }
    setOutcome(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOutcome('idle'), COPIED_MS);
  };

  const overflowing = metrics.content > metrics.view + 1 && metrics.view > 0;
  const trackRatio = overflowing ? metrics.view / metrics.content : 1;
  const trackStart = overflowing ? metrics.offset / metrics.content : 0;
  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    setMetrics({ offset: contentOffset.x, content: contentSize.width, view: layoutMeasurement.width });
  };

  return (
    <View style={styles.wrap}>
      <View role="group" accessibilityLabel={block.a11y.label} style={styles.frame}>
        <View style={styles.header}>
          <Text variant="label" color={overlay.onDarkMuted} style={styles.title}>
            {title}
          </Text>
          <Button
            label={outcome === 'copied' ? 'Copied' : outcome === 'failed' ? 'Copy failed' : 'Copy'}
            accessibilityHint={outcome === 'idle' ? 'Copies the code' : undefined}
            variant="space"
            size="sm"
            icon={outcome === 'copied' ? 'check' : 'copy'}
            surface="dark"
            onPress={() => void copy()}
          />
        </View>
        <ScrollView
          horizontal
          accessibilityLabel="Code example, scrolls horizontally"
          showsHorizontalScrollIndicator
          // Keyboard focus on the web, so the arrow keys can scroll the code.
          tabIndex={0}
          contentContainerStyle={styles.code}
          scrollEventThrottle={32}
          onScroll={onScroll}
          onLayout={(event: LayoutChangeEvent) =>
            setMetrics((previous) => ({ ...previous, view: event.nativeEvent.layout.width }))
          }
          onContentSizeChange={(width) => setMetrics((previous) => ({ ...previous, content: width }))}
        >
          <View {...blockAttributes(block.id)}>
            {lines.map((line, index) => (
              <View
                key={index}
                testID={`code-line-${index + 1}`}
                style={[styles.line, highlighted.has(index + 1) ? styles.highlighted : null]}
              >
                <Text variant="body" color={space.label} selectable style={type}>
                  {line === '' ? ' ' : line}
                </Text>
              </View>
            ))}
          </View>
        </ScrollView>
        {overflowing ? (
          // Decorative: where the code is scrolled to. The scroller itself is the control.
          <View accessible={false} aria-hidden importantForAccessibility="no-hide-descendants" style={styles.track}>
            <View style={[styles.thumb, { width: `${trackRatio * 100}%`, marginLeft: `${trackStart * 100}%` }]} />
          </View>
        ) : null}
      </View>
      {block.data.caption === undefined ? null : (
        <Text variant="meta" color={content.ink2}>
          {block.data.caption}
        </Text>
      )}
      <View accessibilityLiveRegion="polite" role="status" style={styles.status}>
        <Text variant="meta" color={content.ink2}>
          {outcome === 'copied' ? 'Code copied' : outcome === 'failed' ? 'Could not copy the code' : ''}
        </Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: spacing[2] },
  frame: {
    overflow: 'hidden',
    borderRadius: radius.lg,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.ink,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing[3],
    paddingVertical: spacing['1.5'],
    paddingLeft: spacing['3.5'],
    paddingRight: spacing['1.5'],
    borderBottomWidth: borderWidth.hairline,
    borderBottomColor: overlay.onMediaTrack,
  },
  title: { flex: 1 },
  code: { paddingVertical: spacing['3.5'], minWidth: '100%' },
  line: { paddingHorizontal: spacing['3.5'] },
  highlighted: { backgroundColor: space.s2 },
  track: {
    height: spacing[1],
    marginHorizontal: spacing['3.5'],
    marginBottom: spacing[3],
    borderRadius: radius.xs,
    backgroundColor: overlay.onMediaTrack,
    overflow: 'hidden',
  },
  thumb: { height: spacing[1], borderRadius: radius.xs, backgroundColor: overlay.onDarkMuted },
  // Present for assistive technology only when something was said; takes no room otherwise.
  status: { height: 0, overflow: 'hidden' },
});

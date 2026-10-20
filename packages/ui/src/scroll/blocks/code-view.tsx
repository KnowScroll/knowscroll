import { useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
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
  const highlighted = new Set(block.data.highlightLines);
  const lines = block.data.code.split('\n');
  const language = LANGUAGE_LABELS[block.data.language];
  const title = block.data.title === undefined ? language : `${language} · ${block.data.title}`;

  const copy = async () => {
    context.report(block.id, 'copy');
    let next: 'copied' | 'failed' = 'copied';
    try {
      // Loaded when it is needed: no native clipboard module is touched until a reader copies.
      const { setStringAsync } = await import('expo-clipboard');
      await setStringAsync(block.data.code);
    } catch {
      next = 'failed';
    }
    setOutcome(next);
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOutcome('idle'), COPIED_MS);
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
  // Present for assistive technology only when something was said; takes no room otherwise.
  status: { height: 0, overflow: 'hidden' },
});

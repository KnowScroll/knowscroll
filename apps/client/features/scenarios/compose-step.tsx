import { useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import type { ScenarioKind } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Button, Text, useTypeStyle } from '@knowscroll/ui';
import type { KindedStart } from './scenario-start';
import { sheetStyles } from './sheet-styles';

const MAX_WORDS = 500;

/** Step one (X01): the kind, where the request starts from, and the member's own words. */
export function ComposeStep({
  start,
  words,
  onWords,
  onAsk,
}: {
  readonly start: KindedStart;
  readonly words: string;
  readonly onWords: (text: string) => void;
  readonly onAsk: (kind: ScenarioKind, text: string) => void;
}) {
  const [kind, setKind] = useState(start.kind);
  const type = useTypeStyle('bodyS');
  const text = words.trim();
  return (
    <View style={sheetStyles.step}>
      <View style={styles.kinds} role="radiogroup" accessibilityLabel="What kind of branch">
        <Button
          label="What if…"
          variant={kind === 'what_if' ? 'ink' : 'ghost'}
          icon="hypothetical"
          toggled={kind === 'what_if'}
          onPress={() => setKind('what_if')}
        />
        <Button
          label="Another perspective"
          variant={kind === 'perspective' ? 'ink' : 'ghost'}
          toggled={kind === 'perspective'}
          onPress={() => setKind('perspective')}
        />
      </View>
      <View style={styles.from}>
        <Text variant="monoXs" color={content.ink2}>
          FROM: {start.fromLabel.toUpperCase()}
        </Text>
      </View>
      <Text variant="uiS">Your idea</Text>
      <TextInput
        accessibilityLabel="Your idea"
        placeholder={kind === 'what_if' ? 'What if…' : 'Another way to look at it…'}
        placeholderTextColor={content.ink2}
        value={words}
        onChangeText={(next) => onWords(next.replaceAll(/[\r\n]+/gu, ' ').slice(0, MAX_WORDS))}
        multiline
        maxLength={MAX_WORDS}
        allowFontScaling={false}
        style={[
          sheetStyles.input,
          { fontFamily: type.fontFamily, fontSize: type.fontSize, lineHeight: type.lineHeight },
        ]}
      />
      <Button label="Continue" variant="primary" fullWidth disabled={text === ''} onPress={() => onAsk(kind, text)} />
      <Text variant="meta" color={content.ink2}>
        Nothing is made yet. You’ll see what we’d explore, and choose.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  kinds: { flexDirection: 'row', gap: spacing[2], flexWrap: 'wrap' },
  from: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: radius.pill,
    borderWidth: borderWidth.light,
    borderColor: content.ink,
  },
});

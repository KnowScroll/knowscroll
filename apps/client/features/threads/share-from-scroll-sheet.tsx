import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, TextInput, useWindowDimensions, View } from 'react-native';
import { passageOf, sentenceRanges, type PassageRange, type ScrollBlockStateStore } from '@knowscroll/client-core';
import type { SendThreadBody } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { BottomSheet, Banner, Button, Text, useFocusRing, useTypeStyle } from '@knowscroll/ui';
import {
  buildBlockStateSnapshot,
  defaultBlockState,
  describeBlockState,
  findBlock,
  projectText,
  quoteHash,
  walkBlocks,
  type ScrollDocument,
} from '@knowscroll/scroll-model';
import type { SnippetSendStatus } from './use-snippet-send';

interface Passage {
  readonly blockId: string;
  readonly text: string;
}
interface Interactive {
  readonly blockId: string;
  readonly label: string;
}

/** The shareable parts of a Scroll: text blocks to quote from, and blocks that have settings. */
function shareableParts(document: ScrollDocument): { passages: Passage[]; interactives: Interactive[] } {
  const passages: Passage[] = [];
  const interactives: Interactive[] = [];
  for (const { block } of walkBlocks(document.sections)) {
    const text = projectText(block);
    if (text !== null && block.type !== 'subheading' && text.trim().length >= 20) passages.push({ blockId: block.id, text });
    if (defaultBlockState(block) !== null && block.type !== 'disclosure')
      interactives.push({ blockId: block.id, label: block.a11y.label });
  }
  return { passages, interactives };
}

function Choice({ label, detail, onPress }: { label: string; detail?: string; onPress: () => void }) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable {...focus.props} role="button" accessibilityLabel={label} onPress={onPress} style={[styles.choice, focus.style]}>
      <Text variant="uiS" numberOfLines={3}>
        {label}
      </Text>
      {detail === undefined ? null : (
        <Text variant="meta" color={content.ink2}>
          {detail}
        </Text>
      )}
    </Pressable>
  );
}

function PassagePicker({
  passage,
  onShare,
  onBack,
}: {
  readonly passage: Passage;
  readonly onShare: (range: PassageRange) => void;
  readonly onBack: () => void;
}) {
  const sentences = useMemo(() => sentenceRanges(passage.text), [passage.text]);
  const [picked, setPicked] = useState<{ first: number; last: number }>();
  const chosen = picked === undefined ? undefined : passageOf(sentences, picked.first, picked.last);
  const choose = (index: number) =>
    setPicked(picked === undefined || picked.first !== picked.last ? { first: index, last: index } : { first: picked.first, last: index });
  return (
    <View style={styles.step}>
      <Text variant="meta" color={content.ink2}>
        Tap the first sentence, then the last one to take a longer passage.
      </Text>
      {sentences.map((range, index) => {
        const inside =
          chosen !== undefined && range.start >= chosen.start && range.end <= chosen.end;
        return (
          <Pressable
            key={range.start}
            role="checkbox"
            aria-checked={inside}
            accessibilityLabel={passage.text.slice(range.start, range.end)}
            onPress={() => choose(index)}
            style={[styles.sentence, inside ? styles.sentenceOn : null]}
          >
            <Text variant="bodyS">{passage.text.slice(range.start, range.end)}</Text>
          </Pressable>
        );
      })}
      <View style={styles.actions}>
        <Button label="Back" variant="ghost" onPress={onBack} />
        <Button
          label="Share passage"
          variant="primary"
          disabled={chosen === undefined}
          onPress={() => chosen !== undefined && onShare(chosen)}
          testID="share-passage"
        />
      </View>
    </View>
  );
}

function BlockPicker({
  document,
  store,
  item,
  onShare,
  onBack,
}: {
  readonly document: ScrollDocument;
  readonly store: ScrollBlockStateStore;
  readonly item: Interactive;
  readonly onShare: (body: { include: boolean; includePersonal: boolean }) => void;
  readonly onBack: () => void;
}) {
  const block = findBlock(document, item.blockId)?.block;
  const key = { assetId: document.assetId, revision: document.revision, blockId: item.blockId };
  const state = block === undefined ? null : (store.get(key) ?? defaultBlockState(block));
  const [include, setInclude] = useState(true);
  const [includePersonal, setIncludePersonal] = useState(false);
  if (block === undefined || state === null) return null;
  const hasPersonal = block.type === 'simulation' && block.data.params.some((param) => param.personal === true);
  const preview = (personal: boolean) => {
    const snapshot = buildBlockStateSnapshot(block, state, { includePersonal: personal });
    return snapshot.kind === 'snapshot' ? describeBlockState(block, snapshot.snapshot.state) : '';
  };
  return (
    <View style={styles.step}>
      <View style={styles.toggle}>
        <View style={styles.grow}>
          <Text variant="ui">Include how I set it</Text>
          <Text variant="meta" color={content.ink2}>
            {include ? preview(includePersonal) || 'Default settings' : 'Settings are not included'}
          </Text>
        </View>
        <Switch accessibilityLabel="Include how I set it" value={include} onValueChange={setInclude} />
      </View>
      {include && hasPersonal ? (
        <View style={styles.toggle}>
          <View style={styles.grow}>
            <Text variant="ui">Include my own value</Text>
            <Text variant="meta" color={content.ink2}>
              A number you typed yourself stays out unless you say so.
            </Text>
          </View>
          <Switch accessibilityLabel="Include my own value" value={includePersonal} onValueChange={setIncludePersonal} />
        </View>
      ) : null}
      <View style={styles.actions}>
        <Button label="Back" variant="ghost" onPress={onBack} />
        <Button
          label="Share this"
          variant="primary"
          onPress={() => onShare({ include, includePersonal: include && includePersonal })}
          testID="share-block"
        />
      </View>
    </View>
  );
}

/**
 * H03 on a Scroll: share a passage (a run of sentences of one block, on the words the reader sees)
 * or an interactive block, with or without the settings the reader has chosen. Passages are picked by
 * sentence, which also works with a keyboard and a screen reader; the quote travels with its hash so
 * the server can check it against the exact revision. A value the reader typed themselves is left out
 * unless they turn it on. Sharing writes into this thread only.
 */
export function ShareFromScrollSheet({
  visible,
  document,
  store,
  threadName,
  status,
  onShare,
  onClose,
}: {
  readonly visible: boolean;
  readonly document: ScrollDocument;
  readonly store: ScrollBlockStateStore;
  readonly threadName: string;
  readonly status: SnippetSendStatus;
  readonly onShare: (body: Extract<SendThreadBody, { kind: 'snippet' }>['anchor'], note: string) => void;
  readonly onClose: () => void;
}) {
  const parts = useMemo(() => shareableParts(document), [document]);
  const [step, setStep] = useState<{ kind: 'list' } | { kind: 'passage'; passage: Passage } | { kind: 'block'; item: Interactive }>({
    kind: 'list',
  });
  const [note, setNote] = useState('');
  const type = useTypeStyle('bodyS');
  const { height } = useWindowDimensions();
  const share = (anchor: Parameters<typeof onShare>[0]) => onShare(anchor, note.trim());
  return (
    <BottomSheet visible={visible} title="Share from this Scroll" onClose={onClose}>
      <ScrollView style={{ maxHeight: height * 0.62 }} contentContainerStyle={styles.sheet}>
        {step.kind === 'list' ? (
          <>
            <Text variant="uiS">A passage</Text>
            {parts.passages.map((passage) => (
              <Choice
                key={passage.blockId}
                label={passage.text.length > 90 ? `${passage.text.slice(0, 90)}…` : passage.text}
                onPress={() => setStep({ kind: 'passage', passage })}
              />
            ))}
            {parts.interactives.length === 0 ? null : <Text variant="uiS">A diagram, simulation or steps</Text>}
            {parts.interactives.map((item) => (
              <Choice key={item.blockId} label={item.label} onPress={() => setStep({ kind: 'block', item })} />
            ))}
          </>
        ) : null}
        {step.kind === 'passage' ? (
          <PassagePicker
            passage={step.passage}
            onBack={() => setStep({ kind: 'list' })}
            onShare={(range) =>
              share({
                kind: 'scroll_passage',
                blockId: step.passage.blockId,
                start: range.start,
                end: range.end,
                quoteHash: quoteHash(step.passage.text.slice(range.start, range.end)),
              })
            }
          />
        ) : null}
        {step.kind === 'block' ? (
          <BlockPicker
            document={document}
            store={store}
            item={step.item}
            onBack={() => setStep({ kind: 'list' })}
            onShare={({ include, includePersonal }) => {
              const block = findBlock(document, step.item.blockId)?.block;
              if (block === undefined) return;
              const key = { assetId: document.assetId, revision: document.revision, blockId: block.id };
              const state = store.get(key) ?? defaultBlockState(block);
              const snapshot = !include || state === null ? undefined : buildBlockStateSnapshot(block, state, { includePersonal });
              share({
                kind: 'scroll_block',
                blockId: block.id,
                blockType: block.type,
                blockVersion: block.version,
                ...(snapshot?.kind === 'snapshot'
                  ? { settings: { snapshot: snapshot.snapshot, ...(includePersonal ? { confirmPersonal: true } : {}) } }
                  : {}),
              });
            }}
          />
        ) : null}
        {step.kind === 'list' ? null : (
          <View style={styles.field}>
            <Text variant="uiS">Message (optional)</Text>
            <TextInput
              accessibilityLabel="Message (optional)"
              value={note}
              onChangeText={setNote}
              maxLength={500}
              allowFontScaling={false}
              style={[styles.input, { fontFamily: type.fontFamily, fontSize: type.fontSize, lineHeight: type.lineHeight }]}
            />
          </View>
        )}
        <Text variant="monoXs" color={content.ink2}>
          To · {threadName}
        </Text>
        {status === 'sending' ? <Text variant="meta">Sharing…</Text> : null}
        {status === 'unconfirmed' ? (
          <Banner kind="error" lead="Couldn’t confirm it was shared." message="Sharing again sends the same message, so it can’t arrive twice." />
        ) : null}
        {status === 'unavailable' || status === 'invalid' || status === 'failed' ? (
          <Banner kind="error" lead="Couldn’t share this." message="Nothing was sent. The Scroll may have been updated." />
        ) : null}
      </ScrollView>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: spacing[3], paddingBottom: spacing[2] },
  step: { gap: spacing[3] },
  choice: {
    gap: spacing[1],
    padding: spacing[3],
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.md,
    backgroundColor: content.paper,
  },
  sentence: {
    padding: spacing[3],
    borderWidth: borderWidth.light,
    borderColor: content.muted,
    borderRadius: radius.md,
  },
  sentenceOn: { backgroundColor: content.highlight, borderColor: content.ink, borderWidth: borderWidth.regular },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  grow: { flex: 1 },
  actions: { flexDirection: 'row', gap: spacing[2], justifyContent: 'flex-end' },
  field: { gap: spacing[1] },
  input: {
    minHeight: 48,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    borderRadius: radius.md,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[2],
    color: content.ink,
    backgroundColor: content.paper,
  },
});

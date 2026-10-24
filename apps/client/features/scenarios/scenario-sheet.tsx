import { useEffect, useState } from 'react';
import { StyleSheet, TextInput, View } from 'react-native';
import {
  chipText,
  describeOption,
  subjectOfStatement,
  type AccountScope,
  type ScenarioAsk,
  type ScenarioBlock,
  type ScenarioComposerState,
} from '@knowscroll/client-core';
import type { Assumption, ContentThreadRef, ScenarioCard, ScenarioKind, ScenarioOption } from '@knowscroll/contracts';
import { borderWidth, content, radius, spacing, status } from '@knowscroll/design-tokens';
import { Banner, BottomSheet, Button, Spinner, Tag, Text, useTypeStyle } from '@knowscroll/ui';
import { MessageStep, type MessageQuote } from './message-step';
import { useScenarioComposer } from './use-scenarios';

/** Where a request starts: its kind, where in the thread it came from and what it continues. */
export interface ScenarioStart {
  /** Absent when the request started from a message's menu: the member picks the kind first (`quote`). */
  readonly kind?: ScenarioKind;
  /** What the message says, shown above the choice of kind. */
  readonly quote?: MessageQuote;
  readonly origin: ScenarioAsk['origin'];
  /** "the whole thread", "Ravi’s message", "a moment someone shared": the source in words (X01 "From:"). */
  readonly fromLabel: string;
  readonly parent: ScenarioAsk['parent'];
}

/** A start whose kind is known: the member picked it, or the entry point named it. */
type KindedStart = ScenarioStart & { readonly kind: ScenarioKind };

const MAX_WORDS = 500;
const blockMessage: Record<ScenarioBlock, string> = {
  budget: 'No more branches can be made in this thread right now. Try again later.',
  unsupported: 'This can’t be explored yet: nothing it rests on can be looked up.',
  invalid: 'That wording isn’t accepted. Keep it to a plain sentence, without web addresses.',
  stale: 'This changed while you were writing. Close this and start again from it.',
  unavailable: 'This thread isn’t available any more.',
  offline: 'Couldn’t reach KnowScroll. Nothing was lost; try again.',
};

function AssumptionChips({ option }: { readonly option: Pick<ScenarioOption, 'changes' | 'kept' | 'lens'> }) {
  return (
    <View style={styles.chips} accessibilityLabel={describeOption(option)}>
      {option.lens === undefined ? null : (
        <View style={[styles.chip, styles.changedChip]}>
          <Text variant="uiS" color={status.hypothetical.foreground}>
            Lens: {option.lens}
          </Text>
        </View>
      )}
      {option.changes.map((change) => (
        <View key={`c-${change.subject}`} style={[styles.chip, styles.changedChip]}>
          <Text variant="uiS" color={status.hypothetical.foreground}>
            {chipText('Changed', change)}
          </Text>
        </View>
      ))}
      {option.kept.map((keep) => (
        <View key={`k-${keep.subject}`} style={styles.chip}>
          <Text variant="uiS">{chipText('Kept', keep)}</Text>
        </View>
      ))}
    </View>
  );
}

/** Step one (X01): the kind, where the request starts from, and the member's own words. */
function ComposeStep({
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
    <View style={styles.step}>
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
        style={[styles.input, { fontFamily: type.fontFamily, fontSize: type.fontSize, lineHeight: type.lineHeight }]}
      />
      <Button label="Continue" variant="primary" fullWidth disabled={text === ''} onPress={() => onAsk(kind, text)} />
      <Text variant="meta" color={content.ink2}>
        Nothing is made yet. You’ll see what we’d explore, and choose.
      </Text>
    </View>
  );
}

/** Rows of one assumption each, editable as sentences, for the member's own complete request. */
function AssumptionRows({
  title,
  rows,
  max,
  min,
  onChange,
}: {
  readonly title: string;
  readonly rows: readonly Assumption[];
  readonly max: number;
  readonly min: number;
  readonly onChange: (next: readonly Assumption[]) => void;
}) {
  const type = useTypeStyle('bodyS');
  const set = (index: number, statement: string) =>
    onChange(rows.map((row, at) => (at === index ? { subject: row.subject, statement } : row)));
  return (
    <View style={styles.rows}>
      <Text variant="uiS">{title}</Text>
      {rows.map((row, index) => (
        <View key={row.subject + String(index)} style={styles.row}>
          <TextInput
            accessibilityLabel={`${title} ${String(index + 1)}`}
            value={row.statement}
            onChangeText={(statement) => set(index, statement.slice(0, 160))}
            maxLength={160}
            allowFontScaling={false}
            style={[styles.input, styles.rowInput, { fontFamily: type.fontFamily, fontSize: type.fontSize }]}
          />
          {rows.length > min ? (
            <Button
              label="Remove"
              size="sm"
              variant="ghost"
              onPress={() => onChange(rows.filter((_, at) => at !== index))}
            />
          ) : null}
        </View>
      ))}
      {rows.length < max ? (
        <Button
          label="Add"
          size="sm"
          variant="ghost"
          icon="plus"
          onPress={() => onChange([...rows, { subject: `idea ${String(rows.length + 1)}`, statement: '' }])}
        />
      ) : null}
    </View>
  );
}

/** The member's own complete request: what changes and what stays, or the lens (Edit). */
function OwnStep({
  kind,
  initial,
  busy,
  onSubmit,
  onCancel,
}: {
  readonly kind: ScenarioKind;
  readonly initial: Pick<ScenarioOption, 'changes' | 'kept' | 'lens'> | undefined;
  readonly busy: boolean;
  readonly onSubmit: (selection: { changes: Assumption[]; kept: Assumption[]; lens?: string }) => void;
  readonly onCancel: () => void;
}) {
  const [changes, setChanges] = useState<readonly Assumption[]>(
    initial?.changes ?? [{ subject: 'idea', statement: '' }],
  );
  const [kept, setKept] = useState<readonly Assumption[]>(initial?.kept ?? []);
  const [lens, setLens] = useState(initial?.lens ?? '');
  const type = useTypeStyle('bodyS');
  const named = (rows: readonly Assumption[]) =>
    rows
      .map((row) => ({ subject: subjectOfStatement(row.statement), statement: row.statement.trim() }))
      .filter((row) => row.statement.length >= 3);
  const ready = kind === 'what_if' ? named(changes).length > 0 : lens.trim().length >= 3;
  return (
    <View style={styles.step}>
      {kind === 'what_if' ? (
        <>
          <AssumptionRows title="What changes" rows={changes} max={2} min={1} onChange={setChanges} />
          <AssumptionRows title="What stays the same" rows={kept} max={3} min={0} onChange={setKept} />
        </>
      ) : (
        <View style={styles.rows}>
          <Text variant="uiS">The lens</Text>
          <TextInput
            accessibilityLabel="The lens"
            placeholder="For example, the view of the person on call"
            placeholderTextColor={content.ink2}
            value={lens}
            onChangeText={(next) => setLens(next.slice(0, 80))}
            maxLength={80}
            allowFontScaling={false}
            style={[styles.input, { fontFamily: type.fontFamily, fontSize: type.fontSize }]}
          />
        </View>
      )}
      <Button
        label="Explore"
        variant="primary"
        fullWidth
        disabled={!ready}
        busy={busy}
        busyLabel="Starting"
        onPress={() =>
          onSubmit(
            kind === 'what_if'
              ? { changes: named(changes), kept: named(kept) }
              : { changes: [], kept: [], lens: lens.trim() },
          )
        }
      />
      <Button label="Back" variant="ghost" fullWidth onPress={onCancel} />
    </View>
  );
}

/** What we would explore, for one clear idea (X01 first phone): the summary, Edit, Explore. */
function SummaryStep({
  option,
  busy,
  onExplore,
  onEdit,
}: {
  readonly option: ScenarioOption;
  readonly busy: boolean;
  readonly onExplore: () => void;
  readonly onEdit: () => void;
}) {
  return (
    <View style={styles.step}>
      <View style={styles.summary}>
        <View style={styles.summaryTop}>
          <Text variant="monoXs" color={content.ink2}>
            WE’LL EXPLORE
          </Text>
          <Button label="Edit" size="sm" variant="ghost" onPress={onEdit} />
        </View>
        <Text variant="ui">{option.title}</Text>
        <AssumptionChips option={option} />
      </View>
      <Button
        label="Explore"
        variant="primary"
        fullWidth
        busy={busy}
        busyLabel="Starting"
        icon="hypothetical"
        onPress={onExplore}
      />
      <Text variant="meta" color={content.ink2}>
        Everyone in this thread will see the branch. Each of you opens it at your own pace.
      </Text>
    </View>
  );
}

/** Several directions to pick from (Suggested branches): the member picks one, and that is the only thing that makes anything. */
function OptionsStep({
  options,
  busy,
  onExplore,
  onEdit,
}: {
  readonly options: readonly ScenarioOption[];
  readonly busy: boolean;
  readonly onExplore: (option: ScenarioOption) => void;
  readonly onEdit: (option: ScenarioOption) => void;
}) {
  return (
    <View style={styles.step} role="list" accessibilityLabel="Suggested directions">
      <Text variant="meta" color={content.ink2}>
        Suggestions. Nothing is made until you choose one.
      </Text>
      {options.map((option) => (
        <View key={option.optionId} style={styles.summary} role="listitem">
          <Text variant="ui">{option.title}</Text>
          <Text variant="bodyS" color={content.ink2}>
            {option.explanation}
          </Text>
          <AssumptionChips option={option} />
          <View style={styles.actions}>
            <Button
              label="Explore this"
              variant="primary"
              size="sm"
              busy={busy}
              busyLabel="Starting"
              onPress={() => onExplore(option)}
            />
            <Button label="Edit" size="sm" variant="ghost" onPress={() => onEdit(option)} />
          </View>
        </View>
      ))}
    </View>
  );
}

/** The confirm step for an unclear or speculative idea (X01 third phone): the premise, stated, before anything is made. */
function ConfirmStep({
  option,
  busy,
  onCreate,
  onEdit,
  onCancel,
}: {
  readonly option: ScenarioOption;
  readonly busy: boolean;
  readonly onCreate: () => void;
  readonly onEdit: () => void;
  readonly onCancel: () => void;
}) {
  return (
    <View style={styles.step}>
      <View style={styles.notice} role="note">
        <Text variant="uiS">Speculative scenario · not established science</Text>
        <Text variant="bodyS">
          A quick check first. The branch will say that this is an idea, not something that is known, and will compare
          it with what is established.
        </Text>
      </View>
      <Text variant="ui">{option.title}</Text>
      <AssumptionChips option={option} />
      <Text variant="meta" color={content.ink2}>
        Everyone in this thread will see the branch. Each of you opens it at your own pace.
      </Text>
      <View style={styles.actions}>
        <Button label="Create branch" variant="primary" busy={busy} busyLabel="Creating" onPress={onCreate} />
        <Button label="Edit" variant="ghost" onPress={onEdit} />
        <Button label="Cancel" variant="ghost" onPress={onCancel} />
      </View>
    </View>
  );
}

function Thinking({ onOwn }: { readonly onOwn: () => void }) {
  return (
    <View style={styles.step}>
      <View style={styles.thinking} role="status" accessibilityLabel="Thinking of directions">
        <Spinner size={18} color={content.ink} />
        <Text variant="bodyS">Thinking of directions…</Text>
      </View>
      <Text variant="meta" color={content.ink2}>
        You can wait, or write your own version now.
      </Text>
      <Button label="Write my own version" variant="ghost" fullWidth onPress={onOwn} />
    </View>
  );
}

/** The steps of the composer, by what the controller says. */
function SheetBody({
  start,
  scope,
  thread,
  onClose,
  onChosen,
}: {
  readonly start: KindedStart;
  readonly scope: AccountScope;
  readonly thread: ContentThreadRef;
  readonly onClose: () => void;
  readonly onChosen: (card: ScenarioCard) => void;
}) {
  const { controller, state } = useScenarioComposer(scope, thread);
  const draftKey = `scenario.draft.${thread.threadId}`;
  const [words, setWords] = useState(() => scope.storage.get(draftKey) ?? '');
  const [editing, setEditing] = useState<{ kind: ScenarioKind; option: ScenarioOption | undefined } | undefined>();
  const [confirming, setConfirming] = useState<ScenarioOption | undefined>();
  const keepWords = (next: string) => {
    setWords(next);
    if (next === '') scope.storage.remove(draftKey);
    else scope.storage.set(draftKey, next);
  };
  const kind = state.ask?.kind ?? start.kind;
  const choosing = state.phase === 'choosing';
  // A branch exists: the draft words have done their work.
  const chosenNow = state.phase === 'chosen';
  useEffect(() => {
    if (chosenNow) scope.storage.remove(draftKey);
  }, [chosenNow, scope, draftKey]);

  const submitOwn = async (selection: { changes: Assumption[]; kept: Assumption[]; lens?: string }) => {
    await controller.choose({ kind: 'own', ...selection });
  };
  const choose = (option: ScenarioOption) => void controller.choose({ kind: 'suggestion', optionId: option.optionId });

  if (state.chosen !== undefined) {
    const { card, reused } = state.chosen;
    return (
      <Chosen
        card={card}
        reused={reused}
        onClose={() => {
          onChosen(card);
          onClose();
        }}
      />
    );
  }
  if (state.phase === 'blocked' && state.block !== undefined)
    return <Blocked block={state.block} onRetry={() => void controller.retry()} onClose={onClose} />;
  if (editing !== undefined)
    return (
      <OwnStep
        kind={editing.kind}
        initial={editing.option}
        busy={choosing}
        onSubmit={(selection) => void submitOwn(selection)}
        onCancel={() => setEditing(undefined)}
      />
    );
  if (state.phase === 'idle')
    return (
      <ComposeStep
        start={start}
        words={words}
        onWords={keepWords}
        onAsk={(askKind, text) =>
          void controller.begin({ kind: askKind, origin: start.origin, parent: start.parent, text })
        }
      />
    );
  if (state.phase === 'sending' || state.phase === 'thinking')
    return <Thinking onOwn={() => setEditing({ kind, option: undefined })} />;
  if (state.phase === 'failed')
    return (
      <View style={styles.step}>
        <Banner
          kind="info"
          lead="No suggestions."
          message={
            state.failure === 'budget_unavailable'
              ? 'Suggestions are used up for now.'
              : 'We couldn’t think of directions this time.'
          }
        />
        <Button
          label="Write my own version"
          variant="primary"
          fullWidth
          onPress={() => setEditing({ kind, option: undefined })}
        />
        <Button label="Close" variant="ghost" fullWidth onPress={onClose} />
      </View>
    );
  return (
    <Directions
      state={state}
      confirming={confirming}
      onConfirm={setConfirming}
      onEdit={(option) => setEditing({ kind, option })}
      onChoose={choose}
      choosing={choosing}
    />
  );
}

function Directions({
  state,
  confirming,
  onConfirm,
  onEdit,
  onChoose,
  choosing,
}: {
  readonly state: ScenarioComposerState;
  readonly confirming: ScenarioOption | undefined;
  readonly onConfirm: (option: ScenarioOption | undefined) => void;
  readonly onEdit: (option: ScenarioOption) => void;
  readonly onChoose: (option: ScenarioOption) => void;
  readonly choosing: boolean;
}) {
  const [only] = state.options;
  const single = state.mode === 'direct' && only !== undefined ? only : undefined;
  // An unclear or speculative idea asks for confirmation first, whether it came alone or among others.
  const confirm = confirming ?? (single?.needsConfirmation === true ? single : undefined);
  if (confirm !== undefined)
    return (
      <ConfirmStep
        option={confirm}
        busy={choosing}
        onCreate={() => onChoose(confirm)}
        onEdit={() => onEdit(confirm)}
        onCancel={() => onConfirm(undefined)}
      />
    );
  if (single !== undefined)
    return (
      <SummaryStep option={single} busy={choosing} onExplore={() => onChoose(single)} onEdit={() => onEdit(single)} />
    );
  return (
    <OptionsStep
      options={state.options}
      busy={choosing}
      onExplore={(option) => (option.needsConfirmation ? onConfirm(option) : onChoose(option))}
      onEdit={onEdit}
    />
  );
}

function Chosen({
  card,
  reused,
  onClose,
}: {
  readonly card: ScenarioCard;
  readonly reused: boolean;
  readonly onClose: () => void;
}) {
  return (
    <View style={styles.step} role="status">
      <Tag variant="hypothetical" label={card.hypothetical ? 'Hypothetical' : 'Another perspective'} />
      <Text variant="ui">{reused ? 'This branch was already started.' : 'Branch started.'}</Text>
      <Text variant="bodyS" color={content.ink2}>
        {card.status === 'ready'
          ? 'It’s ready in the thread.'
          : 'It shows up in the thread now, and changes when it’s ready. You can keep chatting.'}
      </Text>
      <Button label="Back to the thread" variant="primary" fullWidth onPress={onClose} />
    </View>
  );
}

function Blocked({
  block,
  onRetry,
  onClose,
}: {
  readonly block: ScenarioBlock;
  readonly onRetry: () => void;
  readonly onClose: () => void;
}) {
  return (
    <View style={styles.step}>
      <Banner
        kind={block === 'offline' ? 'offline' : 'error'}
        lead={block === 'offline' ? 'Offline.' : 'Can’t do that.'}
        message={blockMessage[block]}
      />
      {block === 'offline' ? (
        <Button label="Try again" variant="primary" fullWidth icon="retry" onPress={onRetry} />
      ) : null}
      <Button label="Close" variant="ghost" fullWidth onPress={onClose} />
    </View>
  );
}

/**
 * X01: What if… and Another perspective, from the conversation. An overlay, not a route: closing it
 * returns to the same place in the thread, and the member's words survive leaving it. The model only
 * proposes directions; the member's choice is the only thing that makes a branch.
 */
export function ScenarioSheet({
  start,
  scope,
  thread,
  onClose,
  onChosen,
}: {
  /** `undefined` while the sheet is closed; each opening starts a fresh composer. */
  readonly start: ScenarioStart | undefined;
  readonly scope: AccountScope;
  readonly thread: ContentThreadRef;
  readonly onClose: () => void;
  readonly onChosen: (card: ScenarioCard) => void;
}) {
  const [picked, setPicked] = useState<ScenarioKind>();
  const close = () => {
    setPicked(undefined);
    onClose();
  };
  const kind = start?.kind ?? picked;
  const choosingKind = start !== undefined && kind === undefined;
  return (
    <BottomSheet
      visible={start !== undefined}
      title={choosingKind ? 'From this message' : 'What if…'}
      onClose={close}
      testID="scenario-sheet"
    >
      {start === undefined ? null : kind === undefined ? (
        <MessageStep quote={start.quote ?? { authorName: '', preview: '' }} onPick={setPicked} onCancel={close} />
      ) : (
        <SheetBody
          key={`${kind}:${JSON.stringify(start.origin)}`}
          start={{ ...start, kind }}
          scope={scope}
          thread={thread}
          onClose={close}
          onChosen={onChosen}
        />
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  step: { gap: spacing[3] },
  kinds: { flexDirection: 'row', gap: spacing[2], flexWrap: 'wrap' },
  from: {
    alignSelf: 'flex-start',
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: radius.pill,
    borderWidth: borderWidth.light,
    borderColor: content.ink,
  },
  input: {
    minHeight: 48,
    maxHeight: 160,
    borderWidth: borderWidth.regular,
    borderRadius: radius.card,
    borderColor: status.hypothetical.edge,
    borderStyle: 'dashed',
    backgroundColor: status.hypothetical.background,
    color: content.ink,
    paddingHorizontal: spacing[4],
    paddingVertical: spacing[3],
  },
  rows: { gap: spacing[2] },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing[2] },
  rowInput: { flex: 1 },
  summary: {
    gap: spacing[2],
    padding: spacing[4],
    borderWidth: borderWidth.regular,
    borderRadius: radius.card,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  summaryTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  chip: {
    maxWidth: '100%',
    flexShrink: 1,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
    borderRadius: radius.card,
    borderWidth: borderWidth.light,
    borderColor: content.ink,
  },
  changedChip: { borderStyle: 'dashed', borderColor: status.hypothetical.edge },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2], alignItems: 'center' },
  notice: {
    gap: spacing[1],
    padding: spacing[4],
    borderWidth: borderWidth.regular,
    borderRadius: radius.card,
    borderColor: status.hypothetical.edge,
    backgroundColor: status.hypothetical.background,
  },
  thinking: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
});

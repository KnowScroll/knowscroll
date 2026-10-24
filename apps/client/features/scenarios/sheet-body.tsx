import { useEffect, useRef, useState } from 'react';
import type { AccountScope, ScenarioComposerState, ScenarioSelection } from '@knowscroll/client-core';
import type { ContentThreadRef, ScenarioCard, ScenarioKind, ScenarioOption } from '@knowscroll/contracts';
import { ComposeStep } from './compose-step';
import { ConfirmStep, OptionsStep, SummaryStep } from './direction-steps';
import { BlockedStep, ChosenStep, NoSuggestionsStep, ThinkingStep } from './outcome-steps';
import { OwnRequestForm } from './own-request-form';
import type { KindedStart, OfferStart } from './scenario-start';
import { useScenarioComposer } from './use-scenarios';

/** The directions the Planner proposed: one idea to explore, a few to pick from, or one that wants confirming first. */
function Directions({
  state,
  confirming,
  onConfirm,
  onEdit,
  onChoose,
}: {
  readonly state: ScenarioComposerState;
  readonly confirming: ScenarioOption | undefined;
  readonly onConfirm: (option: ScenarioOption | undefined) => void;
  readonly onEdit: (option: ScenarioOption) => void;
  readonly onChoose: (option: ScenarioOption) => void;
}) {
  const busy = state.phase === 'choosing';
  const [only] = state.options;
  const single = state.mode === 'direct' && only !== undefined ? only : undefined;
  // An unclear or speculative idea asks for confirmation first, whether it came alone or among others.
  const confirm = confirming ?? (single?.needsConfirmation === true ? single : undefined);
  if (confirm !== undefined)
    return (
      <ConfirmStep
        option={confirm}
        busy={busy}
        onCreate={() => onChoose(confirm)}
        onEdit={() => onEdit(confirm)}
        onCancel={() => onConfirm(undefined)}
      />
    );
  if (single !== undefined)
    return <SummaryStep option={single} busy={busy} onExplore={() => onChoose(single)} onEdit={() => onEdit(single)} />;
  return (
    <OptionsStep
      options={state.options}
      busy={busy}
      onExplore={(option) => (option.needsConfirmation ? onConfirm(option) : onChoose(option))}
      onEdit={onEdit}
    />
  );
}

/**
 * The steps of the composer, by what its controller says. The member's words survive closing the sheet
 * (kept on the device until a branch exists); nothing here makes a branch except an explicit choice.
 */
export function SheetBody({
  start,
  scope,
  thread,
  onClose,
  onChosen,
}: {
  readonly start: KindedStart | OfferStart;
  readonly scope: AccountScope;
  readonly thread: ContentThreadRef;
  readonly onClose: () => void;
  readonly onChosen: (card: ScenarioCard) => void;
}) {
  const { controller, state } = useScenarioComposer(scope, thread);
  const draftKey = `scenario.draft.${thread.threadId}`;
  const [words, setWords] = useState(() => scope.storage.get(draftKey) ?? '');
  const [editing, setEditing] = useState<{ option: ScenarioOption | undefined } | undefined>();
  const [confirming, setConfirming] = useState<ScenarioOption | undefined>();
  const kind: ScenarioKind = state.ask?.kind ?? ('offer' in start ? start.offer.kind : start.kind);
  const keepWords = (next: string) => {
    setWords(next);
    if (next === '') scope.storage.remove(draftKey);
    else scope.storage.set(draftKey, next);
  };
  // A request that arrives written, or an offer the member already has, needs no first step.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    if ('offer' in start) void controller.attach(start.offer.draftId);
    else if (start.words !== undefined)
      void controller.begin({ kind: start.kind, origin: start.origin, parent: start.parent, text: start.words });
  }, [controller, start]);
  // A branch exists: the draft words have done their work.
  const chosenNow = state.phase === 'chosen';
  useEffect(() => {
    if (chosenNow) scope.storage.remove(draftKey);
  }, [chosenNow, scope, draftKey]);

  const choose = (selection: ScenarioSelection) => void controller.choose(selection);
  const writeOwn = () => setEditing({ option: undefined });

  if (state.chosen !== undefined) {
    const { card, reused } = state.chosen;
    return (
      <ChosenStep
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
    return <BlockedStep block={state.block} onRetry={() => void controller.retry()} onClose={onClose} />;
  if (editing !== undefined)
    return (
      <OwnRequestForm
        kind={kind}
        initial={editing.option}
        premises={start.premises}
        busy={state.phase === 'choosing'}
        onSubmit={choose}
        onCancel={() => setEditing(undefined)}
      />
    );
  if (state.phase === 'idle' && !('offer' in start))
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
  if (state.phase === 'sending' || state.phase === 'thinking') return <ThinkingStep onOwn={writeOwn} />;
  if (state.phase === 'failed') return <NoSuggestionsStep reason={state.failure} onOwn={writeOwn} onClose={onClose} />;
  return (
    <Directions
      state={state}
      confirming={confirming}
      onConfirm={setConfirming}
      onEdit={(option) => setEditing({ option })}
      onChoose={(option) => choose({ kind: 'suggestion', optionId: option.optionId })}
    />
  );
}

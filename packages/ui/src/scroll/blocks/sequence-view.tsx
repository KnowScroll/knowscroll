import { StyleSheet, View } from 'react-native';
import { content, spacing } from '@knowscroll/design-tokens';
import type { BlockOfType } from '@knowscroll/scroll-model';
import { Button } from '../../actions/button';
import { useDisplay } from '../../display/display';
import { Text } from '../../text/text';
import { useBlockState, useScrollRender } from '../context';
import { blockAttributes } from '../data-attributes';
import { RichSpans } from '../rich-text';
import { MediaPlaceholder } from './media-views';
import { BlockFrame } from './frame';
import { BlockActions, BlockLabel, ResetButton, ResetNotice } from './parts';

type Step = BlockOfType<'sequence'>['data']['steps'][number];

function StepBody({ block, step }: { readonly block: BlockOfType<'sequence'>; readonly step: Step }) {
  const context = useScrollRender();
  const { reducedMotion } = useDisplay();
  const request =
    step.figure === undefined
      ? null
      : ({ kind: 'still', media: step.figure.media, alt: step.figure.alt, reducedMotion } as const);
  const figure = request === null ? null : (context.renderMedia?.(request) ?? <MediaPlaceholder request={request} />);
  return (
    <View style={styles.step}>
      <Text variant="ui" style={styles.stepTitle}>
        {step.title}
      </Text>
      <Text variant="body" selectable {...blockAttributes(block.id)}>
        <RichSpans spans={step.spans} blockId={block.id} />
      </Text>
      {figure}
    </View>
  );
}

/**
 * A stepper: one step at a time with Previous and Next, the position said in words ("Step 2 of
 * 5") and announced when it changes. The text version lists every step. The current step is the
 * reader's state, kept by (revision, block). Steps change at once, so reduced motion needs no
 * variant ("change step without sliding").
 */
export function SequenceView({ block }: { readonly block: BlockOfType<'sequence'> }) {
  const context = useScrollRender();
  const handle = useBlockState(block);
  const { title, steps } = block.data;
  const currentId = handle.state?.type === 'sequence' ? handle.state.step : steps[0]?.id;
  const found = steps.findIndex((step) => step.id === currentId);
  const index = found < 0 ? 0 : found;
  const current = steps[index];
  const go = (next: number) => {
    const target = steps[next];
    if (target === undefined) return;
    handle.setState({ type: 'sequence', step: target.id });
    context.report(block.id, 'step');
  };

  if (context.textVersion) {
    return (
      <BlockFrame accessibilityLabel={block.a11y.label} description={block.a11y.description}>
        <BlockLabel>{title}</BlockLabel>
        <View role="list" style={styles.list}>
          {steps.map((step, position) => (
            <View key={step.id} role="listitem">
              <Text variant="body" selectable>
                <Text variant="body" style={styles.stepTitle}>{`${position + 1}. ${step.title}. `}</Text>
                <RichSpans spans={step.spans} blockId={block.id} />
              </Text>
            </View>
          ))}
        </View>
      </BlockFrame>
    );
  }

  return (
    <BlockFrame accessibilityLabel={block.a11y.label} description={block.a11y.description}>
      <BlockLabel>{title}</BlockLabel>
      {handle.resetNotice ? <ResetNotice onDismiss={handle.dismissNotice} /> : null}
      <View accessibilityLiveRegion="polite" role="status">
        <Text variant="label" color={content.ink2}>{`Step ${index + 1} of ${steps.length}`}</Text>
        {current === undefined ? null : <StepBody block={block} step={current} />}
      </View>
      <BlockActions>
        <Button
          label="Previous"
          size="sm"
          icon="arrowLeft"
          disabled={index === 0}
          onPress={() => go(index - 1)}
          accessibilityHint={`Step ${index} of ${steps.length}`}
        />
        <Button
          label="Next"
          size="sm"
          variant="primary"
          icon="arrowRight"
          iconPosition="trailing"
          disabled={index === steps.length - 1}
          onPress={() => go(index + 1)}
          accessibilityHint={`Step ${index + 2} of ${steps.length}`}
        />
        <ResetButton
          disabled={index === 0}
          onPress={() => {
            handle.reset();
            context.report(block.id, 'control');
          }}
        />
      </BlockActions>
    </BlockFrame>
  );
}

const styles = StyleSheet.create({
  step: { gap: spacing[2], paddingTop: spacing[2] },
  stepTitle: { fontWeight: '700' },
  list: { gap: spacing[3] },
});

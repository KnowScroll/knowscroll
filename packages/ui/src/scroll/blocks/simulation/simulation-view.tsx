import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import {
  ILLUSTRATIVE_NOTICE,
  curveUsable,
  evaluateSimulation,
  formatWithUnit,
  isIllustrative,
  outputsUsable,
  readoutBand,
  renderTemplate,
  resolveParams,
  sampleCurve,
  type BlockOfType,
  type SimulationParam,
} from '../../model';
import { content, spacing } from '@knowscroll/design-tokens';
import { Tag } from '../../../status/tag';
import { Text } from '../../../text/text';
import { useBlockState, useScrollRender } from '../../context';
import { FallbackView } from '../fallback';
import { BlockFrame } from '../frame';
import { BlockActions, BlockTitle, ResetButton, ResetNotice } from '../parts';
import { NumberInput, Stepper } from './controls';
import { Slider, SliderRange } from './slider-view';
import { AreaView, CardsView, PlotView, ReadoutView } from './views';

type Data = BlockOfType<'simulation'>['data'];

/** Evaluated points are guarded: a non-finite output at runtime shows the block's fallback text, never "NaN". */
function ParamControl({
  param,
  value,
  textVersion,
  onPreview,
  onCommit,
  onDragging,
}: {
  readonly param: SimulationParam;
  readonly value: number;
  readonly textVersion: boolean;
  readonly onPreview: (value: number) => void;
  readonly onCommit: (value: number, how: 'drag' | 'control') => void;
  readonly onDragging: (dragging: boolean) => void;
}) {
  const label = (
    <View style={styles.label}>
      <Text variant="bodyS" style={styles.bold}>
        {param.label}
      </Text>
      {param.control === 'slider' && !textVersion ? (
        <Text variant="bodyS">{formatWithUnit(value, param.format, param.unit)}</Text>
      ) : null}
    </View>
  );
  const change = (next: number) => onCommit(next, 'control');
  return (
    <View style={styles.control}>
      {label}
      {textVersion || param.control === 'stepper' ? (
        <Stepper param={param} value={value} onChange={change} />
      ) : param.control === 'input' ? (
        <NumberInput param={param} value={value} onChange={change} />
      ) : (
        <>
          <Slider param={param} value={value} onPreview={onPreview} onCommit={onCommit} onDragging={onDragging} />
          <SliderRange param={param} />
        </>
      )}
      {param.personal === true ? (
        <Text variant="meta" color={content.ink2}>
          Stays on this device unless you choose to include it when you share.
        </Text>
      ) : null}
    </View>
  );
}

/** The outputs in words: the text version of every view. */
function OutputList({ data, values }: { readonly data: Data; readonly values: ReturnType<typeof evaluateSimulation> }) {
  return (
    <View role="list" style={styles.outputs}>
      {data.outputs.map((output) => (
        <View key={output.key} role="listitem">
          <Text variant="body">{`${output.label}: ${formatWithUnit(values.outputs[output.key] ?? null, output.format, output.unit)}`}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * A parameterised simulation: controls bound to the parameters the document declares (sliders,
 * steppers, typed numbers), and one of four views of the outputs. Every number comes from the
 * package's closed formula kinds (`evaluateSimulation`); no model JavaScript is ever executed.
 * The reader's values are the block's state, kept by (revision, block). The block says whether it
 * captures a gesture (a slider does: horizontal, after the axis locks). Its text version swaps the
 * views for the outputs in words and every control for a stepper. An illustrative simulation shows
 * its notice next to the view, always.
 */
export function SimulationView({ block }: { readonly block: BlockOfType<'simulation'> }) {
  const context = useScrollRender();
  const handle = useBlockState(block);
  const data = block.data;
  const [drag, setDrag] = useState<{ key: string; value: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const committed = handle.state?.type === 'simulation' ? handle.state.params : undefined;
  const shownParams = useMemo(
    () => resolveParams(data, drag === null ? committed : { ...committed, [drag.key]: drag.value }),
    [data, committed, drag],
  );
  const values = useMemo(() => evaluateSimulation(data, shownParams), [data, shownParams]);
  const view = data.view;
  const curve = useMemo(
    () => (view.kind === 'plot' ? sampleCurve(data, shownParams, view.x, view.y) : null),
    [data, shownParams, view],
  );
  const usable = outputsUsable(values) && (curve === null || curveUsable(curve));
  const diagnose = context.diagnose;
  useEffect(() => {
    if (!usable) diagnose({ blockId: block.id, blockType: 'simulation', reason: 'non-finite-output' });
  }, [usable, diagnose, block.id]);

  const defaults = resolveParams(data);
  const atDefaults = data.params.every((param) => shownParams[param.key] === defaults[param.key]);
  const commit = (param: SimulationParam, value: number, how: 'drag' | 'control') => {
    setDrag(null);
    handle.setState({ type: 'simulation', params: { ...shownParams, [param.key]: value } });
    context.report(block.id, how === 'drag' ? 'drag' : 'control');
  };
  const textual = context.textVersion;
  const sentence = !usable || data.readout === undefined ? null : renderTemplate(data.readout.template, data, values);
  const band = !usable || data.readout === undefined ? null : readoutBand(data.readout, values);

  return (
    <BlockFrame
      accessibilityLabel={block.a11y.label}
      description={block.a11y.description}
      active={dragging}
      style={styles.frame}
    >
      <View style={styles.header}>
        <View style={styles.titleText}>
          <BlockTitle>{data.title}</BlockTitle>
          {data.prompt === undefined ? null : (
            <Text variant="meta" color={content.ink2}>
              {data.prompt}
            </Text>
          )}
        </View>
        {isIllustrative(data) ? <Tag label={ILLUSTRATIVE_NOTICE} /> : null}
      </View>
      {handle.resetNotice ? <ResetNotice onDismiss={handle.dismissNotice} /> : null}
      {data.params.map((param) => (
        <ParamControl
          key={param.key}
          param={param}
          value={shownParams[param.key] ?? param.default}
          textVersion={textual}
          onPreview={(value) => setDrag({ key: param.key, value })}
          onCommit={(value, how) => commit(param, value, how)}
          onDragging={setDragging}
        />
      ))}
      <View style={styles.results}>
        {!usable ? (
          // A value the model cannot show (a non-finite output): the block's own words in place of
          // the view, the readout and the bars, never "NaN". The controls stay, so the reader can
          // move to a value that works.
          <FallbackView blockType="simulation" text={block.fallbackText} cause="load" />
        ) : textual ? (
          <OutputList data={data} values={values} />
        ) : view.kind === 'readout' ? (
          <ReadoutView data={data} values={values} />
        ) : view.kind === 'cards' ? (
          <CardsView data={data} values={values} />
        ) : view.kind === 'plot' ? (
          <PlotView data={data} values={values} curve={curve ?? []} />
        ) : (
          <AreaView data={data} values={values} />
        )}
        {sentence === null ? null : (
          <View accessibilityLiveRegion="polite" role="status" style={styles.sentence}>
            <Text variant="body">{sentence}</Text>
            {band === null ? null : (
              <Text variant="bodyS" color={content.ink2}>
                {band}
              </Text>
            )}
          </View>
        )}
        <Text variant="meta" color={content.ink2}>
          {`${isIllustrative(data) ? `${ILLUSTRATIVE_NOTICE}. ` : ''}${data.modelNote}`}
        </Text>
      </View>
      <BlockActions>
        <ResetButton
          disabled={atDefaults}
          onPress={() => {
            handle.reset();
            setDrag(null);
            context.report(block.id, 'control');
          }}
        />
      </BlockActions>
    </BlockFrame>
  );
}

const styles = StyleSheet.create({
  frame: { gap: spacing[4] },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: spacing[3] },
  titleText: { flex: 1, gap: spacing[1] },
  control: { gap: spacing[2] },
  label: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', gap: spacing[3] },
  bold: { fontWeight: '700' },
  results: { gap: spacing[3] },
  outputs: { gap: spacing[2] },
  sentence: { gap: spacing[1], paddingTop: spacing[2] },
});

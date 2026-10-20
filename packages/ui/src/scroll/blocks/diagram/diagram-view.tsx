import { useMemo, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { content, spacing, target as touchTarget } from '@knowscroll/design-tokens';
import type { BlockOfType } from '@knowscroll/scroll-model';
import { Button } from '../../../actions/button';
import { Text } from '../../../text/text';
import { useBlockState, useScrollRender } from '../../context';
import { BlockFrame } from '../frame';
import { BlockActions, BlockTitle, ResetButton, ResetNotice } from '../parts';
import { DiagramCanvas } from './diagram-canvas';
import { describeDiagram } from './describe';
import { initialFrame, keepInside, targetAt, type DragToTarget } from './drag-model';
import { useDragGesture } from './drag-gesture';
import { frameView } from './frame-view';
import { CANVAS_WIDTH, layoutDiagram, type Point } from './layout';

type Block = BlockOfType<'diagram'>;

/** The diagram in words: what is in it and how it is joined (the frame is already said above). Built from the document alone. */
function DiagramText({ data, frameId }: { readonly data: Block['data']; readonly frameId: string | null }) {
  const description = describeDiagram(data, frameId);
  return (
    <View style={styles.text}>
      <Text variant="bodyS" selectable>
        <Text variant="bodyS" style={styles.bold}>
          {'In the diagram: '}
        </Text>
        {description.nodes.join(', ')}
        {'.'}
      </Text>
      {description.connections.length === 0 ? null : (
        <View role="list" style={styles.connections}>
          {description.connections.map((connection) => (
            <View key={connection} role="listitem">
              <Text variant="bodyS" selectable>
                {connection}
              </Text>
            </View>
          ))}
        </View>
      )}
    </View>
  );
}

/**
 * A diagram with authored frames (E03-1): static, stepped (Previous and Next), toggled (one
 * button per frame) or drag-to-target (drag the token onto a node; that node chooses the frame,
 * dropping anywhere else changes nothing). There is no physics: a frame emphasises and hides
 * nodes and edges and re-weights edges. The block that drags captures both axes and owns the drag
 * until release (`two-axis`); every drag has a button: the same choice as a list of targets, so a
 * keyboard or a screen reader is never left out. "Describe this diagram" and the article's text
 * version give the diagram in words; Reset returns to the first frame. Frames switch at once, so
 * reduced motion needs no variant.
 */
export function DiagramView({ block }: { readonly block: Block }) {
  const context = useScrollRender();
  const handle = useBlockState(block);
  const data = block.data;
  const { interaction, frames } = data;
  const layout = useMemo(() => layoutDiagram(data), [data]);
  const [width, setWidth] = useState(0);
  const [described, setDescribed] = useState(false);
  const [dragAt, setDragAt] = useState<Point | null>(null);

  const frameId = handle.state?.type === 'diagram' ? handle.state.frame : null;
  const current = frames.find((frame) => frame.id === frameId) ?? frames[0];
  const view = frameView(data, current?.id ?? null);
  const token =
    interaction.kind === 'drag-to-target' ? layout.nodes.find((node) => node.id === interaction.token) : undefined;
  const drag: DragToTarget | null = interaction.kind === 'drag-to-target' ? interaction : null;
  const over = drag === null || dragAt === null ? null : targetAt(layout, drag, dragAt);
  const unit = width > 0 ? CANVAS_WIDTH / width : 1;
  const scale = width > 0 ? width / CANVAS_WIDTH : 1;

  const choose = (frame: string, kind: 'step' | 'drag' | 'control') => {
    handle.setState({ type: 'diagram', frame });
    context.report(block.id, kind);
  };
  const gesture = useDragGesture({
    enabled: drag !== null,
    unit,
    home: token === undefined ? { x: 0, y: 0 } : { x: token.x, y: token.y },
    onStart: () => setDragAt(token === undefined ? null : { x: token.x, y: token.y }),
    onMove: (point) => setDragAt(token === undefined ? point : keepInside(layout, token, point)),
    onDrop: (point) => {
      const hit =
        drag === null ? null : targetAt(layout, drag, token === undefined ? point : keepInside(layout, token, point));
      if (hit !== null) choose(hit.frame, 'drag');
    },
    onEnd: () => setDragAt(null),
  });

  const index = current === undefined ? 0 : frames.indexOf(current);
  const start = initialFrame(interaction, frames[0]?.id);
  const atStart = current?.id === start;
  const textual = context.textVersion || described;

  const canvas = (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={block.a11y.label}
      accessibilityHint={block.a11y.description}
      onLayout={(event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width)}
      style={[styles.canvas, { aspectRatio: CANVAS_WIDTH / layout.height }]}
    >
      <DiagramCanvas
        data={data}
        layout={layout}
        view={view}
        tokenId={token?.id ?? null}
        tokenAt={dragAt}
        overNode={over?.node ?? null}
      />
      {token === undefined || drag === null
        ? null
        : gesture.wrap(
            <View
              testID={`diagram-token-${token.id}`}
              accessible={false}
              importantForAccessibility="no"
              {...gesture.viewProps}
              style={[
                styles.handle,
                {
                  left: token.x * scale - Math.max(touchTarget.minimum, token.width * scale) / 2,
                  top: token.y * scale - Math.max(touchTarget.minimum, token.height * scale) / 2,
                  width: Math.max(touchTarget.minimum, token.width * scale),
                  height: Math.max(touchTarget.minimum, token.height * scale),
                },
                gesture.viewProps['style'] as object | undefined,
              ]}
            />,
          )}
    </View>
  );

  return (
    <BlockFrame
      accessibilityLabel={block.a11y.label}
      description={block.a11y.description}
      hero
      active={dragAt !== null}
    >
      <BlockTitle>{data.title}</BlockTitle>
      {data.instruction === undefined ? null : (
        <Text variant="meta" color={content.ink2}>
          {data.instruction}
        </Text>
      )}
      {handle.resetNotice ? <ResetNotice onDismiss={handle.dismissNotice} /> : null}
      {context.textVersion ? null : canvas}
      {current === undefined ? null : (
        <View accessibilityLiveRegion="polite" role="status" style={styles.frame}>
          <Text variant="bodyS">
            <Text variant="bodyS" style={styles.bold}>{`${current.label}. `}</Text>
            {current.description}
          </Text>
        </View>
      )}
      {interaction.kind === 'steps' ? (
        <BlockActions>
          <Button
            label="Previous"
            size="sm"
            icon="arrowLeft"
            disabled={index <= 0}
            onPress={() => choose(frames[index - 1]?.id ?? '', 'step')}
          />
          <Text variant="label" color={content.ink2}>{`Step ${index + 1} of ${frames.length}`}</Text>
          <Button
            label="Next"
            size="sm"
            variant="primary"
            icon="arrowRight"
            iconPosition="trailing"
            disabled={index >= frames.length - 1}
            onPress={() => choose(frames[index + 1]?.id ?? '', 'step')}
          />
        </BlockActions>
      ) : null}
      {interaction.kind === 'toggle' ? (
        <BlockActions>
          {frames.map((frame) => (
            <Button
              key={frame.id}
              label={frame.label}
              size="sm"
              toggled={frame.id === current?.id}
              variant={frame.id === current?.id ? 'primary' : 'default'}
              onPress={() => choose(frame.id, 'step')}
            />
          ))}
        </BlockActions>
      ) : null}
      {drag === null ? null : (
        <View role="group" accessibilityLabel="Or choose where to move it" style={styles.targets}>
          {drag.targets.map((entry) => {
            const node = data.nodes.find((candidate) => candidate.id === entry.node);
            const label = node?.label ?? entry.node;
            return (
              <Button
                key={entry.node}
                label={`Toward ${label}`}
                size="sm"
                variant="ghost"
                toggled={current?.id === entry.frame}
                onPress={() => choose(entry.frame, 'control')}
              />
            );
          })}
        </View>
      )}
      {textual ? <DiagramText data={data} frameId={current?.id ?? null} /> : null}
      <BlockActions>
        {interaction.kind === 'static' ? null : (
          <ResetButton
            disabled={atStart}
            onPress={() => {
              handle.reset();
              context.report(block.id, 'control');
            }}
          />
        )}
        {context.textVersion ? null : (
          <Button
            label={described ? 'Hide description' : 'Describe this diagram'}
            size="sm"
            variant="ghost"
            toggled={described}
            onPress={() => {
              setDescribed((value) => !value);
              context.report(block.id, 'text_version');
            }}
          />
        )}
      </BlockActions>
    </BlockFrame>
  );
}

const styles = StyleSheet.create({
  canvas: { width: '100%', borderRadius: spacing[3], overflow: 'hidden' },
  handle: { position: 'absolute' },
  frame: { gap: spacing[1] },
  bold: { fontWeight: '700' },
  targets: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing[2] },
  text: { gap: spacing[2] },
  connections: { gap: spacing[1] },
});

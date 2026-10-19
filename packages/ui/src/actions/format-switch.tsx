import { useRef } from 'react';
import { Platform, Pressable, StyleSheet, View, type ViewStyle } from 'react-native';
import { borderWidth, content, dimension, opacity, radius, spacing, target } from '@knowscroll/design-tokens';
import { useFocusRing } from '../display/focus-ring';
import { radioGroupSemantics, radioSemantics } from '../display/semantics';
import { PendingStripe } from '../feedback/pending-stripe';
import { Icon } from '../icons/icon';
import { Text } from '../text/text';

export type EncounterFormat = 'reel' | 'scroll';

/** Whether a format of this explanation can be opened now. */
export type FormatAvailability = 'ready' | 'preparing' | 'unavailable';

const formats: readonly EncounterFormat[] = ['reel', 'scroll'];
const formatLabel: Record<EncounterFormat, string> = { reel: 'Reel', scroll: 'Scroll' };

export interface FormatSwitchProps {
  readonly selected: EncounterFormat;
  /** Availability of each format; the selected one is always ready. */
  readonly availability?: Partial<Record<EncounterFormat, FormatAvailability>>;
  readonly onSelect: (format: EncounterFormat) => void;
  /** Show the ▶ / ≡ glyphs (Components.html first instance). */
  readonly showIcons?: boolean;
}

interface Focusable {
  focus?: () => void;
}

function Option({
  format,
  selected,
  availability,
  showIcons,
  onSelect,
  onArrow,
  register,
}: {
  format: EncounterFormat;
  selected: boolean;
  availability: FormatAvailability;
  showIcons: boolean;
  onSelect: (format: EncounterFormat) => void;
  onArrow: (from: EncounterFormat) => void;
  register: (format: EncounterFormat, node: Focusable | null) => void;
}) {
  const focus = useFocusRing('onLight');
  const unavailable = availability === 'unavailable';
  const suffix = availability === 'preparing' ? ' · preparing' : unavailable ? ' · unavailable' : '';
  const foreground = selected ? content.paper : content.ink;
  // Web: one Tab stop for the group (the checked option); arrow keys move between options.
  const keyboard =
    Platform.OS === 'web'
      ? {
          tabIndex: selected ? (0 as const) : (-1 as const),
          onKeyDown: (event: { nativeEvent: unknown; preventDefault: () => void }) => {
            const key = (event.nativeEvent as { key?: string }).key ?? '';
            if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(key)) {
              event.preventDefault();
              onArrow(format);
            }
          },
        }
      : {};
  return (
    <Pressable
      ref={(node) => register(format, node)}
      {...focus.props}
      {...radioSemantics(selected)}
      {...keyboard}
      accessibilityLabel={`${formatLabel[format]}${suffix}`}
      disabled={unavailable}
      aria-disabled={unavailable}
      onPress={selected || unavailable ? undefined : () => onSelect(format)}
      style={() => {
        const frame: ViewStyle[] = [styles.option, { backgroundColor: selected ? content.ink : 'transparent' }];
        if (unavailable) frame.push(styles.unavailable);
        if (focus.style !== undefined) frame.push(focus.style);
        return frame;
      }}
    >
      {availability === 'preparing' && !selected ? (
        <View style={styles.stripe}>
          <PendingStripe compact />
        </View>
      ) : null}
      {showIcons ? <Icon name={format} size={14} color={foreground} /> : null}
      <Text variant="uiS" color={foreground}>
        {formatLabel[format]}
        {suffix}
      </Text>
    </Pressable>
  );
}

/**
 * Reel ⇄ Scroll: the same explanation in the other format, with equal status (D-006 b). Tap
 * only, never a swipe; the same place in the top bar on both formats. A single-choice group
 * (radio semantics, arrow keys on the web); the checked option is the current format. A preparing
 * sibling shows the pending stripe and "· preparing"; choosing it starts the caller's request
 * flow. Options are 44 px tall (the export draws 38; D-006 n).
 */
export function FormatSwitch({ selected, availability = {}, onSelect, showIcons = false }: FormatSwitchProps) {
  const nodes = useRef<Partial<Record<EncounterFormat, Focusable | null>>>({});
  const availabilityOf = (format: EncounterFormat): FormatAvailability =>
    format === selected ? 'ready' : (availability[format] ?? 'ready');
  const onArrow = (from: EncounterFormat) => {
    const next = formats.find((format) => format !== from);
    if (next === undefined || availabilityOf(next) === 'unavailable') return;
    nodes.current[next]?.focus?.();
    onSelect(next);
  };
  return (
    <View {...radioGroupSemantics('Format of this explanation')} style={styles.group}>
      {formats.map((format) => (
        <Option
          key={format}
          format={format}
          selected={format === selected}
          availability={availabilityOf(format)}
          showIcons={showIcons}
          onSelect={onSelect}
          onArrow={onArrow}
          register={(key, node) => {
            nodes.current[key] = node;
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  group: {
    flexDirection: 'row',
    alignSelf: 'flex-start',
    padding: dimension.segmentInset,
    gap: spacing['0.5'],
    borderRadius: radius.pill,
    borderWidth: borderWidth.regular,
    borderColor: content.ink,
    backgroundColor: content.paper,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing['1.5'],
    minHeight: target.minimum,
    paddingHorizontal: spacing['3.5'],
    borderRadius: radius.pill,
    overflow: 'hidden',
    cursor: 'pointer' as const,
  },
  stripe: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, borderRadius: radius.pill, overflow: 'hidden' },
  unavailable: { opacity: opacity.disabled, cursor: 'auto' as const },
});

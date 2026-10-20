import { Component, type ErrorInfo, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { borderWidth, content, radius, spacing } from '@knowscroll/design-tokens';
import { Button } from '../../actions/button';
import { Text } from '../../text/text';

/** What a block is called in "… couldn't load". */
const NOUNS: Readonly<Record<string, string>> = {
  diagram: 'Diagram',
  chart: 'Chart',
  simulation: 'Interactive',
  table: 'Table',
  figure: 'Image',
  media: 'Clip',
  comparison: 'Comparison',
  timeline: 'Timeline',
  sequence: 'Steps',
  disclosure: 'Section',
  code: 'Code',
};

export interface FallbackViewProps {
  /** The block's type as the document names it (`diagram`), or null when it could not be read. */
  readonly blockType: string | null;
  /** The block's own readable stand-in: what the visual would have said. */
  readonly text: string;
  /** `update`: this build cannot render the type. `load`: the block failed to render. */
  readonly cause: 'update' | 'load';
  /** Try again; only for a block that failed while rendering (the same data will not parse differently). */
  readonly onRetry?: () => void;
  readonly testID?: string;
}

/**
 * The readable stand-in for a block that cannot render (E02 "Diagram couldn't load · text
 * version"): never a blank block. It says what happened in one mono line, shows the block's own
 * text, and offers Retry where retrying can help.
 */
export function FallbackView({ blockType, text, cause, onRetry, testID }: FallbackViewProps) {
  const noun = blockType === null ? 'This part' : (NOUNS[blockType] ?? 'This part');
  const label =
    cause === 'update' ? 'This part needs an app update · text version' : `${noun} couldn't load · text version`;
  return (
    <View testID={testID} style={styles.frame}>
      <Text variant="label" color={content.ink2}>
        {label}
      </Text>
      <Text variant="body" selectable>
        {text}
      </Text>
      {onRetry === undefined ? null : (
        <View style={styles.action}>
          <Button
            label={
              blockType === null || NOUNS[blockType] === undefined
                ? 'Try again'
                : `Retry ${NOUNS[blockType].toLowerCase()}`
            }
            size="sm"
            icon="retry"
            onPress={onRetry}
          />
        </View>
      )}
    </View>
  );
}

interface BoundaryProps {
  readonly children: ReactNode;
  readonly onError: (error: unknown) => void;
  readonly fallback: ReactNode;
}

interface BoundaryState {
  readonly failed: boolean;
}

/**
 * Catches a block that throws while it renders, so one bad block never blanks the article: the
 * block's fallback shows instead and the host records a diagnostic. The host remounts it (a new
 * `key`) when the reader taps Retry.
 */
export class BlockBoundary extends Component<BoundaryProps, BoundaryState> {
  override state: BoundaryState = { failed: false };

  static getDerivedStateFromError(): BoundaryState {
    return { failed: true };
  }

  override componentDidCatch(error: unknown, _info: ErrorInfo): void {
    this.props.onError(error);
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

const styles = StyleSheet.create({
  frame: {
    gap: spacing['2.5'],
    padding: spacing['3.5'],
    borderRadius: radius.lg,
    borderWidth: borderWidth.regular,
    borderStyle: 'dashed',
    borderColor: content.ink,
    backgroundColor: content.paper2,
  },
  action: { alignSelf: 'flex-start' },
});

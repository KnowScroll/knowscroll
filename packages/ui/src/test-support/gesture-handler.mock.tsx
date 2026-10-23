import { createElement, type ReactNode } from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

/**
 * A stand-in for react-native-gesture-handler in the Jest runs (`moduleNameMapper` in this
 * package's and the client's Jest configs): the native module does not exist there, and the
 * detectors only need to hand their children through. `usePanGesture` records the configuration a
 * block asked for, so a test can read what the block captures (`activeOffsetX`, `failOffsetY`,
 * `runOnJS`) and drive its callbacks the way a pan would. Real gestures are not exercised here:
 * that needs a device (see the PR's "not proved").
 */
export interface PanEvent {
  readonly x: number;
  readonly y: number;
  readonly translationX: number;
  readonly translationY: number;
}

export interface PanConfig {
  readonly activeOffsetX?: readonly [number, number];
  readonly failOffsetY?: readonly [number, number];
  readonly minDistance?: number;
  readonly runOnJS?: boolean;
  readonly enabled?: boolean;
  readonly onActivate?: (event: PanEvent) => void;
  readonly onUpdate?: (event: PanEvent) => void;
  readonly onDeactivate?: (event: PanEvent) => void;
  readonly onFinalize?: (event: PanEvent) => void;
}

export const panConfigs: PanConfig[] = [];

/** The configuration of the most recent pan a block created. */
export function lastPan(): PanConfig {
  const config = panConfigs[panConfigs.length - 1];
  if (config === undefined) throw new Error('no pan gesture was created');
  return config;
}

export function usePanGesture(config: PanConfig): PanConfig {
  panConfigs.push(config);
  return config;
}

export function GestureDetector({ children }: { gesture: unknown; children: ReactNode }): ReactNode {
  return children;
}

export function GestureHandlerRootView({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  return createElement(View, { style, testID: 'gesture-root' }, children);
}

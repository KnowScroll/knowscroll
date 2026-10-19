import { useEffect, useState } from 'react';
import { Animated, Easing, Platform } from 'react-native';
import { content } from '@knowscroll/design-tokens';
import { useDisplay } from '../display/display';
import { Icon } from '../icons/icon';

/**
 * The spinner arc (`M12 3a9 9 0 0 1 9 9`) that marks busy and preparing states. It turns slowly;
 * under reduced motion it holds still, and the word beside it still says what is happening.
 */
export function Spinner({ size = 18, color = content.ink }: { size?: number; color?: string }) {
  const { reducedMotion } = useDisplay();
  const [turn] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (reducedMotion) {
      turn.setValue(0);
      return undefined;
    }
    const loop = Animated.loop(
      Animated.timing(turn, {
        toValue: 1,
        duration: 900,
        easing: (progress) => Easing.linear(progress),
        useNativeDriver: Platform.OS !== 'web',
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [reducedMotion, turn]);
  const rotate = turn.interpolate({ inputRange: [0, 1], outputRange: ['0deg', '360deg'] });
  return (
    <Animated.View style={{ width: size, height: size, transform: [{ rotate }] }}>
      <Icon name="spinner" size={size} color={color} />
    </Animated.View>
  );
}

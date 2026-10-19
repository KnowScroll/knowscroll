import { useRouter } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { content, dimension } from '@knowscroll/design-tokens';
import { StateBlock } from '@knowscroll/ui';
import { ScreenFrame } from '../shell/screen-frame';

/** C01's two-bubble illustration (96 × 80): one cream, one yellow, ink outlines. */
function TwoBubbles() {
  return (
    <Svg width={96} height={80} viewBox="0 0 96 80">
      <Path
        d="M6 8h56v34H26l-14 12V42H6z"
        fill={content.paper}
        stroke={content.ink}
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
      <Path
        d="M40 30h50v32h-8v12L70 62H40z"
        fill={content.continue}
        stroke={content.ink}
        strokeWidth={2.5}
        strokeLinejoin="round"
      />
    </Svg>
  );
}

/**
 * C01 "Empty · first visit to Talk". Real conversations only, so there is nothing to list. "Share
 * something" goes to Explore; "New message" and "Invite a friend" need the friends and
 * conversations backends, which do not exist yet, so they are not shown.
 */
export function EmptyTalkScreen() {
  const router = useRouter();
  return (
    <ScreenFrame tone="paper" title="Talk" bodyOffset={dimension.stateOffsetPhone.talk}>
      <StateBlock
        illustration={<TwoBubbles />}
        title="No conversations yet"
        body="Share a Reel or Scroll with a friend and the conversation starts here."
        actionLayout="stretch"
        actions={[
          {
            label: 'Share something',
            variant: 'primary',
            role: 'link',
            href: '/explore',
            onPress: () => router.navigate('/explore'),
          },
        ]}
      />
    </ScreenFrame>
  );
}

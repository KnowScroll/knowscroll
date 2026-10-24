import { useRouter } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import { content } from '@knowscroll/design-tokens';
import { StateBlock } from '@knowscroll/ui';

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
 * C01 "Empty · first visit to Talk": real conversations only, so there is nothing to list. A
 * conversation starts when a Reel or Scroll is shared, so "Share something" goes to Explore;
 * "Invite a friend" opens Friends.
 */
export function EmptyTalk() {
  const router = useRouter();
  return (
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
        {
          label: 'Invite a friend',
          variant: 'default',
          role: 'link',
          href: '/friends',
          onPress: () => router.push('/friends'),
        },
      ]}
    />
  );
}

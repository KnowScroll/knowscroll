import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import { StateBlock } from '@knowscroll/ui';
import { useDocumentTitle } from '../../platform/document-title';

/** An address that is not a screen (composed from the empty-state block; not drawn in the export). */
export function NotFoundScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  useDocumentTitle('Page not found');
  return (
    <View role="main" style={[styles.ground, { paddingTop: insets.top + spacing[24] }]}>
      <StateBlock
        title="This page isn't here"
        body="The address may be mistyped, or the page has moved."
        actions={[
          {
            label: 'Go to Explore',
            variant: 'primary',
            role: 'link',
            href: '/explore',
            onPress: () => router.replace('/explore'),
          },
        ]}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: content.paper, paddingHorizontal: layout.gutter, alignItems: 'center' },
});

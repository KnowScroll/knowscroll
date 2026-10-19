import { StyleSheet, Text, View } from 'react-native';
import { colours, fontFamilies } from '../../theme/fonts';

/** The first screen: the product name and promise, set in the bundled display and body fonts. */
export function WelcomeScreen() {
  return (
    <View style={styles.page}>
      <Text accessibilityRole="header" style={styles.title}>
        KnowScroll
      </Text>
      <Text style={styles.promise}>Come here when you want to scroll. Leave with a slightly larger world.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    backgroundColor: colours.paper,
  },
  title: {
    fontFamily: fontFamilies.display,
    fontSize: 44,
    color: colours.ink,
  },
  promise: {
    marginTop: 12,
    maxWidth: 420,
    textAlign: 'center',
    fontFamily: fontFamilies.body,
    fontSize: 17,
    lineHeight: 24,
    color: colours.inkSecondary,
  },
});

import { Redirect } from 'expo-router';

/** The site root opens Explore. */
export default function Index() {
  return <Redirect href="/explore" />;
}

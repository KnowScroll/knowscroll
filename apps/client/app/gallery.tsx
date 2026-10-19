import type { GalleryScreen as GalleryScreenComponent } from '../features/gallery/gallery-screen';
import { NotFoundScreen } from '../features/not-found/not-found-screen';

/**
 * The developer component gallery exists only in builds made with `EXPO_PUBLIC_KS_GALLERY=1`.
 * Production builds inline the variable, so the condition is constant and Metro drops the branch
 * together with its `require`: the gallery code is not in a production export (the client CI job
 * checks the exported bundle), and `/gallery` answers like any unknown address.
 */
const GalleryScreen: typeof GalleryScreenComponent | null =
  process.env.EXPO_PUBLIC_KS_GALLERY === '1'
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- a conditional require is what lets the bundler drop the gallery from production builds
      (require('../features/gallery/gallery-screen') as { GalleryScreen: typeof GalleryScreenComponent }).GalleryScreen
    : null;

export default function Gallery() {
  return GalleryScreen === null ? <NotFoundScreen /> : <GalleryScreen />;
}

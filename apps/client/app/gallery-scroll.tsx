import type { ScrollGalleryScreen as ScrollGalleryScreenComponent } from '../features/gallery/scroll-gallery-screen';
import { NotFoundScreen } from '../features/not-found/not-found-screen';

/**
 * The developer Scroll gallery (every block, both templates, on fixture documents) exists only in
 * builds made with `EXPO_PUBLIC_KS_GALLERY=1`, exactly like `/gallery`: production builds inline
 * the variable, so the condition is constant and Metro drops the branch with its `require`.
 */
type GalleryModule = { ScrollGalleryScreen: typeof ScrollGalleryScreenComponent };

const ScrollGalleryScreen: typeof ScrollGalleryScreenComponent | null =
  process.env.EXPO_PUBLIC_KS_GALLERY === '1'
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- a conditional require is what lets the bundler drop the gallery from production builds
      (require('../features/gallery/scroll-gallery-screen') as GalleryModule).ScrollGalleryScreen
    : null;

export default function ScrollGallery() {
  return ScrollGalleryScreen === null ? <NotFoundScreen /> : <ScrollGalleryScreen />;
}

import type { SpaceGalleryScreen as SpaceGalleryScreenComponent } from '../features/gallery/space-gallery-screen';
import { NotFoundScreen } from '../features/not-found/not-found-screen';

/**
 * The developer space renderer page (v3 U-0) exists only in builds made with
 * `EXPO_PUBLIC_KS_GALLERY=1`, exactly like `/gallery`: production builds inline the variable, so
 * the condition is constant and Metro drops the branch with its `require` (and three.js with it).
 */
type GalleryModule = { SpaceGalleryScreen: typeof SpaceGalleryScreenComponent };

const SpaceGalleryScreen: typeof SpaceGalleryScreenComponent | null =
  process.env.EXPO_PUBLIC_KS_GALLERY === '1'
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- a conditional require is what lets the bundler drop the gallery from production builds
      (require('../features/gallery/space-gallery-screen') as GalleryModule).SpaceGalleryScreen
    : null;

export default function SpaceGallery() {
  return SpaceGalleryScreen === null ? <NotFoundScreen /> : <SpaceGalleryScreen />;
}

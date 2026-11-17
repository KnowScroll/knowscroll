import type { FolioGalleryScreen as FolioGalleryScreenComponent } from '../features/gallery/folio-gallery-screen';
import { NotFoundScreen } from '../features/not-found/not-found-screen';

/**
 * The Folio reader over the v2 fixture documents, with no backend. Like `/gallery-scroll`, it exists only in builds
 * made with `EXPO_PUBLIC_KS_GALLERY=1`: production builds inline the variable, so the condition is constant and Metro
 * drops the branch with its `require`.
 */
type GalleryModule = { FolioGalleryScreen: typeof FolioGalleryScreenComponent };

const FolioGalleryScreen: typeof FolioGalleryScreenComponent | null =
  process.env.EXPO_PUBLIC_KS_GALLERY === '1'
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- a conditional require is what lets the bundler drop the gallery from production builds
      (require('../features/gallery/folio-gallery-screen') as GalleryModule).FolioGalleryScreen
    : null;

export default function FolioGallery() {
  return FolioGalleryScreen === null ? <NotFoundScreen /> : <FolioGalleryScreen />;
}

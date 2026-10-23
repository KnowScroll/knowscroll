import type { NativeDurabilityScreen as Component } from '../features/gallery/native-durability-screen';
import { NotFoundScreen } from '../features/not-found/not-found-screen';
type Module = { NativeDurabilityScreen: typeof Component };
const Screen =
  process.env.EXPO_PUBLIC_KS_GALLERY === '1' && process.env.EXPO_PUBLIC_KS_NATIVE_DURABILITY_CI === '1'
    ? // eslint-disable-next-line @typescript-eslint/no-require-imports -- Constant build flags exclude the entire private fixture body.
      (require('../features/gallery/native-durability-screen') as Module).NativeDurabilityScreen
    : null;
export default function GalleryDurability() {
  return Screen === null ? <NotFoundScreen /> : <Screen />;
}

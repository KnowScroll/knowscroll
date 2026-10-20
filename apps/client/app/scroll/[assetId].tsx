import { ScrollScreen } from '../../features/scroll/scroll-screen';

/** `/scroll/<assetId>`: a Scroll opened by its address (D-006 d). `?anchor=<blockId>` restores a block. */
export default function ScrollRoute() {
  return <ScrollScreen />;
}

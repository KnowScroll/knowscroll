import { setStatusBarStyle } from 'expo-status-bar';
import { useCallback, useEffect, useMemo } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import blackHole from '@knowscroll/scroll-model/fixtures/black-hole-stage-ci.json';
import circulation from '@knowscroll/scroll-model/fixtures/circulation-stage-ci.json';
import greenhouse from '@knowscroll/scroll-model/fixtures/greenhouse-stage-ci.json';
import nerve from '@knowscroll/scroll-model/fixtures/nerve-stage-ci.json';
import scaleChart from '@knowscroll/scroll-model/fixtures/scale-chart-blocks-ci.json';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import sortFork from '@knowscroll/scroll-model/fixtures/sort-fork-blocks-ci.json';
import star from '@knowscroll/scroll-model/fixtures/star-stage-ci.json';
import starlight from '@knowscroll/scroll-model/fixtures/starlight-stage-ci.json';
import tides from '@knowscroll/scroll-model/fixtures/tides-stage-ci.json';
import transit from '@knowscroll/scroll-model/fixtures/transit-stage-ci.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import {
  Button,
  DisplayProvider,
  FigureView,
  FolioReader,
  ReaderDock,
  ReaderTopBar,
  readingModelOfV2,
  scrollPageSurface,
  type FigureState,
  type UnitReadingObserver,
} from '@knowscroll/ui';
import { useDocumentTitle } from '../../platform/document-title';

/** Marker the browser smoke looks for; never in a production export. */
const folioGalleryMarker = 'ks-folio-gallery';

/** The labelled CI fixtures of `scroll-model` (not product content): every kit, and two Scrolls with play blocks and no picture. */
const documents = {
  seasons,
  tides,
  greenhouse,
  star,
  transit,
  circulation,
  nerve,
  starlight,
  blackHole,
  scaleChart,
  sortFork,
} as const;
type DocumentName = keyof typeof documents;

function isDocumentName(value: string | undefined): value is DocumentName {
  return value !== undefined && Object.hasOwn(documents, value);
}

/** What the reader reported, with its clock, for the browser smoke to read (`window.__ksFolioGallery`). */
interface FolioGalleryEvents {
  visibility: { blockId: string; visibleFraction: number; at: number }[];
  activity: { active: boolean; at: number }[];
  stops: (string | undefined)[];
}

const events: FolioGalleryEvents = { visibility: [], activity: [], stops: [] };

const observer: UnitReadingObserver = {
  onBlockVisibility: ({ blockId, visibleFraction, at }) => {
    events.visibility.push({ blockId, visibleFraction, at });
  },
  onActivity: ({ active, at }) => {
    events.activity.push({ active, at });
  },
};

/**
 * Developer gallery of the Folio reader (`/gallery-folio`, gallery builds only): a v2 fixture document through the
 * real adapter (`readingModelOfV2`) and reader, with the app's top bar and dock and no backend. Query: `doc` (a fixture
 * name), `stop` (open at that stop), `motion=reduce`, `scale=2` (200 % text), `bare=1` (no fixture toolbar: the screen as
 * a reader sees it), `figures=1` (every figure state of the document on the page, to check a kit in each appearance).
 */
export function FolioGalleryScreen() {
  useDocumentTitle('Folio gallery');
  useFocusEffect(
    useCallback(() => {
      setStatusBarStyle('dark');
    }, []),
  );
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{
    doc?: string;
    stop?: string;
    motion?: string;
    scale?: string;
    bare?: string;
    figures?: string;
  }>();
  const name: DocumentName = isDocumentName(params.doc) ? params.doc : 'seasons';
  const document = documents[name] as unknown as ScrollDocumentV2;
  const model = useMemo(() => readingModelOfV2(document), [document]);
  useEffect(() => {
    (globalThis as { __ksFolioGallery?: unknown }).__ksFolioGallery = events;
  }, []);
  return (
    <DisplayProvider
      value={{
        ...(params.motion === 'reduce' ? { reducedMotion: true } : {}),
        ...(params.scale === '2' ? { textScale: 2 } : {}),
      }}
    >
      <View testID={folioGalleryMarker} style={[styles.ground, { paddingTop: insets.top }]}>
        {params.bare === '1' ? null : (
          <View role="toolbar" accessibilityLabel="Fixture documents" style={styles.controls}>
            {(Object.keys(documents) as DocumentName[]).map((key) => (
              <Button
                key={key}
                label={key}
                size="sm"
                variant={key === name ? 'primary' : 'default'}
                toggled={key === name}
                onPress={() => router.setParams({ doc: key, stop: undefined })}
              />
            ))}
          </View>
        )}
        {params.figures === '1' ? (
          <FigureSheet model={model} />
        ) : (
          <FolioReader
            key={`${name}:${params.stop ?? ''}`}
            model={model}
            observer={observer}
            initialStopId={params.stop}
            onStopChange={(stopId) => events.stops.push(stopId)}
            commands={{ nextTopic: () => undefined }}
            onDone={() => undefined}
            header={<ReaderTopBar title={document.title} kicker={document.kicker} onUniverse={() => undefined} />}
            dock={
              <View style={{ paddingBottom: insets.bottom }}>
                <ReaderDock onAsk={() => undefined} onMore={() => undefined} />
              </View>
            }
          />
        )}
      </View>
    </DisplayProvider>
  );
}

/** Every distinct figure of the essay, one under the other, on the page: how each kit state looks in each appearance. */
function FigureSheet({ model }: { readonly model: ReturnType<typeof readingModelOfV2> }) {
  const figures = new Map<string, FigureState>();
  for (const section of model.sections) {
    for (const block of section.blocks) {
      if (block.kind === 'figure') figures.set(block.figure.key, block.figure);
      if (block.kind === 'hold') for (const held of block.beats) figures.set(held.figure.key, held.figure);
    }
  }
  if (model.end.figure !== undefined) figures.set(model.end.figure.key, model.end.figure);
  return (
    <ScrollView {...scrollPageSurface()} contentContainerStyle={styles.sheet} testID="figure-sheet">
      {[...figures.values()].map((figure) => (
        <FigureView key={figure.key} figure={figure} height={240} reducedMotion textVersion={false} />
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  sheet: { gap: spacing[4], padding: layout.gutter, backgroundColor: content.paper },
  ground: { flex: 1, backgroundColor: content.paper },
  controls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
    paddingHorizontal: layout.gutter,
    paddingVertical: spacing[2],
  },
});

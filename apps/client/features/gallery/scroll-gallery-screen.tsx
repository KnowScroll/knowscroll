import { useEffect, useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { content, layout, spacing } from '@knowscroll/design-tokens';
import { createScopedBlockStateStore } from '@knowscroll/client-core';
import {
  Button,
  DisplayProvider,
  ErrorState,
  ScrollArticle,
  prepareScrollDocument,
  type ScrollBlockStateStore,
} from '@knowscroll/ui';
import { bridgesPoster, bridgesWithServerFallback, lighthouseEditorial } from '@knowscroll/ui/scroll-fixtures';
import { useDocumentTitle } from '../../platform/document-title';
import { galleryDiagnostics, galleryEvents, galleryObserver } from './scroll-gallery-events';

/** Marker the browser smoke looks for; like the component gallery's, it is never in a production export. */
export const scrollGalleryMarker = 'ks-scroll-gallery';

const documents = {
  bridges: { label: 'Poster', build: bridgesPoster },
  lighthouse: { label: 'Editorial', build: lighthouseEditorial },
  fallback: { label: 'Server fallback', build: bridgesWithServerFallback },
} as const;
type DocumentName = keyof typeof documents;

function isDocumentName(value: string | undefined): value is DocumentName {
  return value !== undefined && Object.hasOwn(documents, value);
}

/**
 * Block state of the gallery: the AccountScope's persistent store implementation (the one the app
 * will use) over a labelled in-memory double of the scope's storage, shared by every document, so
 * switching documents and coming back shows the state kept per (revision, block).
 */
const galleryStorage = new Map<string, string>();
const galleryStore: ScrollBlockStateStore = createScopedBlockStateStore({
  get: (key) => galleryStorage.get(key),
  set: (key, value) => void galleryStorage.set(key, value),
  remove: (key) => void galleryStorage.delete(key),
});

/**
 * Developer gallery of the Scroll renderer (`/gallery-scroll`, only in gallery builds): fixture
 * documents (labelled, original, never product content) through the real client path
 * (`prepareScrollDocument` then `ScrollArticle`). Query: `doc` (bridges · lighthouse · fallback),
 * `block` (a block id: the anchor restore), `motion=reduce`, `scale=2` (200 % text).
 */
export function ScrollGalleryScreen() {
  useDocumentTitle('Scroll gallery');
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ doc?: string; block?: string; motion?: string; scale?: string }>();
  const name: DocumentName = isDocumentName(params.doc) ? params.doc : 'bridges';
  const prepared = useMemo(() => prepareScrollDocument(documents[name].build()), [name]);
  useEffect(() => {
    (globalThis as { __ksScrollGallery?: unknown }).__ksScrollGallery = galleryEvents;
  }, []);

  return (
    <DisplayProvider
      value={{
        ...(params.motion === 'reduce' ? { reducedMotion: true } : {}),
        ...(params.scale === '2' ? { textScale: 2 } : {}),
      }}
    >
      <View testID={scrollGalleryMarker} style={[styles.ground, { paddingTop: insets.top }]}>
        <View role="toolbar" accessibilityLabel="Fixture documents" style={styles.controls}>
          {(Object.keys(documents) as DocumentName[]).map((key) => (
            <Button
              key={key}
              label={documents[key].label}
              size="sm"
              variant={key === name ? 'primary' : 'default'}
              toggled={key === name}
              onPress={() => router.setParams({ doc: key, block: undefined })}
            />
          ))}
        </View>
        {prepared.kind === 'ready' ? (
          <ScrollArticle
            key={`${name}:${params.block ?? ''}`}
            document={prepared.document}
            observer={galleryObserver}
            diagnostics={galleryDiagnostics}
            store={galleryStore}
            {...(params.block === undefined ? {} : { anchorBlockId: params.block })}
            contentInset={{ top: spacing[4], bottom: spacing[18] + insets.bottom }}
          />
        ) : (
          <ErrorState title="This fixture did not parse" body="The client refused the document." />
        )}
      </View>
    </DisplayProvider>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: content.paper },
  controls: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing[2],
    paddingHorizontal: layout.gutter,
    paddingVertical: spacing[2],
  },
});

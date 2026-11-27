import { useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { universe } from '@knowscroll/design-tokens';
import { useDocumentTitle } from '../../platform/document-title';
import { PlanetMapScreen } from '../universe/voyage/maps/planet-map-screen';
import { RegionMapScreen } from '../universe/voyage/maps/region-map-screen';
import { mapsFixture, previewOf } from './maps-gallery-fixtures';
import { readMapsParams } from './maps-gallery-params';

/**
 * `?scene=maps` of the developer space gallery: the two maps of a planet (`PlanetMapScreen`, `RegionMapScreen`) over
 * labelled sample data, full screen, with no account and no session. The Universe's new look opens the same screens over
 * the person's own planet (`universe-surface.tsx`); this page is how they are looked at without one.
 *
 * `map=1|2` picks the screen, `regions=1..12` how many have formed, `seam=1` puts a region across the band's seam (on
 * map 2 it is the one shown), `here=1` marks "you were here", `preview=scroll|reel|loading|offline|unavailable|blocked`
 * is what map 2's preview says, `hypothetical=1` and `type=lush|ocean|frozen|scorched|barren|gas`. Choosing a region on
 * map 1 opens its map and Back returns, so the whole chain can be walked. Open goes nowhere here (a sample has no
 * encounter), and a `blocked` preview refuses it, as the session does when another encounter is in the way.
 */
export function MapsGalleryPage() {
  useDocumentTitle('Maps of a planet · KnowScroll');
  const raw = useLocalSearchParams<Record<string, string>>();
  const params = readMapsParams(raw);
  // The address is rebuilt on every read; the sample is made again only when one of its choices changes.
  const { map, regions, seam, here, preview: previewKind, hypothetical, type } = params;
  const fixture = useMemo(
    () => mapsFixture({ map, regions, seam, here, preview: previewKind, hypothetical, type }),
    [map, regions, seam, here, previewKind, hypothetical, type],
  );
  const preview = useMemo(() => previewOf(previewKind), [previewKind]);
  // Which screen is up: the address picks the first, a tap on map 1 opens map 2 and Back comes home.
  const [shown, setShown] = useState<{ readonly map: 1 | 2; readonly regionId: string; readonly fromMap: boolean }>(
    () => ({ map, regionId: fixture.shownId, fromMap: false }),
  );
  const [last, setLast] = useState('');
  // The built world is kept by this object; the page is its only holder.
  const [session] = useState(() => ({}));
  const region = fixture.regions.find((candidate) => candidate.objectId === shown.regionId) ?? fixture.regions[0]!;
  return (
    <View style={styles.page}>
      {shown.map === 1 ? (
        <PlanetMapScreen
          session={session}
          planet={fixture.planet}
          systemLabel={fixture.systemLabel}
          regions={fixture.regions}
          looks={fixture.looks}
          hereId={fixture.hereId}
          onBack={() => setLast('Back to the planet')}
          onChooseRegion={(regionId) => {
            setLast(`Chose ${regionId}`);
            setShown({ map: 2, regionId, fromMap: true });
          }}
        />
      ) : (
        <RegionMapScreen
          session={session}
          planet={fixture.planet}
          regions={fixture.regions}
          looks={fixture.looks}
          region={region}
          hereId={fixture.hereId}
          preview={preview}
          cameFromMap={shown.fromMap}
          onBack={() => {
            setLast(shown.fromMap ? 'Back to the map' : 'Back to the planet');
            if (shown.fromMap) setShown({ map: 1, regionId: shown.regionId, fromMap: false });
          }}
          onRefreshPreview={() => setLast('Try again')}
          onOpen={(displayed, _onReturn, choice) => {
            setLast(`Open ${choice}`);
            return previewKind !== 'blocked';
          }}
          // A sample has no encounter to go to: the page stays where it is.
          navigate={() => undefined}
        />
      )}
      <View accessibilityLabel={last} testID="ks-maps-last" pointerEvents="none" style={styles.last} />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: universe.sky },
  last: { position: 'absolute', left: 0, top: 0, width: 1, height: 1 },
});

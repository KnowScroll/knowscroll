import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { radius, space, spacing } from '@knowscroll/design-tokens';
import { Button, IconButton, Text, useDisplay } from '@knowscroll/ui';
import { SpaceChip } from '../space-chip';
import { PlaceRow, RowGroup, SIMPLE } from '../simple/place-rows';
import type { CollectionView, LandmarkRow } from './collection-view';

/** The one gentle line under the Orbit (V3 design, p9): nothing the person owns depends on the week. */
export const ORBIT_REASSURANCE = 'Missed a week? Nothing here goes away. Orbits just start fresh on Monday.';

const GLASS = 'rgba(6,26,38,0.92)';
const GLASS_EDGE = 'rgba(255,255,255,0.15)';
const GOLD = '#f5c518';

/** "Part 2 of 3": what the resume chip says. The Scroll's own title is its accessible description. */
export const resumeLabel = (part: number, total: number) => `Resume Part ${String(part)} of ${String(total)}`;

/** Where a landmark stands, in words: its planet, or the tray. */
const placeOf = (row: LandmarkRow) => (row.planet ? `On ${row.planet.name}` : 'Waiting for its planet');

/**
 * The map's own controls for the person's play (V3 E3, D-084, D-087, D-215): "Resume Part 2 of 3" opens the
 * next Part of the series they started, "Landmarks" opens their list, and the week's Orbit is one quiet line
 * of text. Nothing here is drawn on the map; it is never shown on a friend's universe.
 */
export function CollectionStrip({ view, onLandmarks }: { view: CollectionView; onLandmarks: () => void }) {
  const router = useRouter();
  const { resume, orbitText, rows } = view;
  if (!resume && !orbitText && rows.length === 0) return null;
  return (
    <View testID="universe-collection-strip" style={styles.strip}>
      {resume ? (
        <SpaceChip
          testID="universe-resume"
          variant="solid"
          icon="play"
          label={resumeLabel(resume.part, resume.total)}
          accessibilityLabel={`${resumeLabel(resume.part, resume.total)}: ${resume.title}`}
          onPress={() => router.push({ pathname: '/scroll/[assetId]', params: { assetId: resume.assetId } })}
        />
      ) : null}
      <View style={styles.stripRow}>
        {rows.length > 0 ? (
          <SpaceChip
            testID="universe-landmarks"
            variant="solid"
            icon="flag"
            label={`Landmarks · ${String(rows.length)}`}
            onPress={onLandmarks}
          />
        ) : null}
        {orbitText ? (
          <View style={styles.orbit}>
            <Text variant="meta" color={space.label} testID="universe-orbit">
              {orbitText}
            </Text>
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** The tray (D-084): a landmark earned before its planet has formed waits here, and attaches when it does. */
export function LandmarkTray({ view, onSee }: { view: CollectionView; onSee: () => void }) {
  const { breakpoint } = useDisplay();
  const [first] = view.waiting;
  if (!first) return null;
  const more = view.waiting.length - 1;
  return (
    <View
      testID="universe-landmark-tray"
      role="status"
      // On desktop the key hints sit at the bottom right of the map, so the tray keeps to the left.
      style={[styles.tray, breakpoint === 'desktop' ? styles.trayLeft : null]}
    >
      <View style={styles.trayText}>
        <Text variant="label" color={space.label2}>
          {view.waiting.length === 1 ? 'Your landmark is waiting' : 'Your landmarks are waiting'}
        </Text>
        <Text variant="title" heading={2} color="#ffffff" numberOfLines={1}>
          {first.name}
        </Text>
        <Text variant="bodyS" color={space.label2}>
          {`${first.finish}${more > 0 ? ` · and ${String(more)} more` : ''}. `}
          {more > 0
            ? 'They stand on their planets once those have formed.'
            : 'It stands on its planet once that has formed.'}
        </Text>
      </View>
      <Button label="See it" variant="space" onPress={onSee} />
    </View>
  );
}

/** The dark sheet of the landmarks (V3 p9 "Landmarks on…"): every one, where it stands, and the week's Orbit. */
export function CollectionSheet({
  view,
  onClose,
  onPlanet,
}: {
  view: CollectionView;
  onClose: () => void;
  /** Flies to the planet a landmark stands on. */
  onPlanet: (planetId: string) => void;
}) {
  return (
    <View testID="universe-collection-sheet" role="dialog" accessibilityLabel="Landmarks" style={styles.sheet}>
      <View style={styles.sheetHead}>
        <Text variant="title" heading={2} color="#ffffff">
          {`Landmarks · ${String(view.rows.length)}`}
        </Text>
        <IconButton icon="close" label="Close landmarks" variant="onSpace" onPress={onClose} />
      </View>
      <View role="list" style={styles.sheetRows}>
        {view.rows.map((row) => (
          <View key={row.id} role="listitem" style={styles.sheetRow}>
            <View style={[styles.badge, row.tier === 'gold' ? styles.gold : styles.plain]} aria-hidden />
            <View style={styles.sheetRowText}>
              <Text variant="ui" color="#ffffff">
                {row.name}
              </Text>
              <Text variant="bodyS" color={space.label2}>
                {`${row.finish} · ${placeOf(row)}`}
              </Text>
            </View>
            {row.planet ? (
              <Button
                label="Visit"
                size="sm"
                variant="spaceGhost"
                accessibilityLabel={`Go to ${row.planet.name}`}
                onPress={() => onPlanet(row.planet!.id)}
              />
            ) : null}
          </View>
        ))}
      </View>
      {view.orbitText ? (
        <Text variant="meta" color={space.label2}>
          {view.orbitText}
        </Text>
      ) : null}
      <Text variant="bodyS" color={space.label2}>
        {ORBIT_REASSURANCE}
      </Text>
    </View>
  );
}

/**
 * The same collection on paper, for the desktop panel and the Simple lists: the Orbit as a line, the next
 * Part to resume, and each landmark as a row with where it stands. A plain list, so it is also the screen-reader
 * view of what the map paints (D-089).
 */
export function CollectionSection({ view, onPlanet }: { view: CollectionView; onPlanet: (planetId: string) => void }) {
  const router = useRouter();
  const { resume, rows, orbitText } = view;
  if (!resume && !orbitText && rows.length === 0) return null;
  return (
    <View testID="universe-collection-section" style={styles.section}>
      {resume ? (
        <Button
          label={resumeLabel(resume.part, resume.total)}
          icon="play"
          variant="ink"
          accessibilityLabel={`${resumeLabel(resume.part, resume.total)}: ${resume.title}`}
          onPress={() => router.push({ pathname: '/scroll/[assetId]', params: { assetId: resume.assetId } })}
        />
      ) : null}
      {orbitText ? (
        <Text variant="meta" color={SIMPLE.ink2}>
          {orbitText}
        </Text>
      ) : null}
      {rows.length > 0 ? (
        <>
          <Text variant="label" color={SIMPLE.ink2}>
            {`Landmarks · ${String(rows.length)}`}
          </Text>
          <RowGroup label="Landmarks">
            {rows.map((row) => (
              <PlaceRow
                key={row.id}
                title={row.name}
                meta={`${row.finish} · ${placeOf(row)}`}
                {...(row.planet
                  ? {
                      accessibilityLabel: `${row.name}, ${row.finish}, on ${row.planet.name}`,
                      onPress: () => onPlanet(row.planet!.id),
                    }
                  : { accessibilityLabel: `${row.name}, ${row.finish}, waiting for its planet` })}
              />
            ))}
          </RowGroup>
          <Text variant="bodyS" color={SIMPLE.ink2}>
            {ORBIT_REASSURANCE}
          </Text>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  strip: { alignItems: 'flex-start', gap: spacing[2] },
  /** A dark pill, so the line reads over the bright landed map as well as over the sky. */
  orbit: {
    backgroundColor: space.labelChip,
    borderRadius: radius.pill,
    paddingHorizontal: spacing[3],
    paddingVertical: spacing[1],
  },
  stripRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[3] },
  tray: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[3],
    backgroundColor: GLASS,
    borderColor: GLASS_EDGE,
    borderWidth: 1,
    borderRadius: 24,
    padding: spacing[4],
    maxWidth: 460,
    width: '100%',
    alignSelf: 'center',
  },
  trayLeft: { alignSelf: 'flex-start', maxWidth: 440 },
  trayText: { flex: 1, gap: spacing['1.5'] },
  sheet: {
    backgroundColor: GLASS,
    borderColor: GLASS_EDGE,
    borderWidth: 1,
    borderRadius: 24,
    padding: spacing[4],
    gap: spacing[3],
    maxWidth: 460,
    width: '100%',
    alignSelf: 'center',
  },
  sheetHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetRows: { gap: spacing[2] },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  sheetRowText: { flex: 1 },
  badge: { width: 14, height: 14, borderRadius: radius.pill, borderWidth: 2, borderColor: '#15302a' },
  gold: { backgroundColor: GOLD },
  plain: { backgroundColor: '#fffdf2' },
  section: { gap: spacing[2], marginTop: spacing[3] },
});

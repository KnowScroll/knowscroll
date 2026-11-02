import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { radius, space, spacing } from '@knowscroll/design-tokens';
import { Button, Icon, IconButton, Text, useDisplay, useFocusRing } from '@knowscroll/ui';
import { PlaceRow, RowGroup, SIMPLE } from '../simple/place-rows';
import { isNewLandmark, type CollectionView, type LandmarkRow } from './collection-view';
import type { ResumeOffer } from '@knowscroll/client-core';

/** The one gentle line under the Orbit (V3 design, p9): nothing the person owns depends on the week. */
export const ORBIT_REASSURANCE = 'Missed a week? Nothing here goes away. Orbits just start fresh on Monday.';

const PAPER = '#FFFDF2';
const PAPER_INK = '#15302A';
const PAPER_INK2 = 'rgba(21,48,42,0.7)';
const PAPER_TOP = '#F4EDD8';
const GLASS = 'rgba(6,26,38,0.92)';
const GLASS_EDGE = 'rgba(255,255,255,0.15)';
const GOLD = '#f5c518';

/** "Part 2 of 3": what the resume chip says. The Scroll's own title is its accessible description. */
export const resumeLabel = (part: number, total: number) => `Resume Part ${String(part)} of ${String(total)}`;

/** Where a landmark stands, in words: its planet, or the tray. */
const placeOf = (row: LandmarkRow) => (row.planet ? `On ${row.planet.name}` : 'Waiting for its planet');

/** What the card says it is about, from what the person has: their newest landmark, else the next Part, else the week. */
type CardSubject = 'landmark' | 'resume' | 'week';

/** The card's subject, or nothing when there is nothing to say yet. */
export function cardSubjectOf(view: CollectionView): CardSubject | undefined {
  if (view.rows.length > 0) return 'landmark';
  if (view.resume) return 'resume';
  return view.orbitText ? 'week' : undefined;
}

/** "New landmark" while the newest landmark is recent, "Latest landmark" after. */
const landmarkHeading = (row: LandmarkRow) => (isNewLandmark(row) ? 'New landmark' : 'Latest landmark');

/** "from Seasons · gold finish": where the newest landmark stands, or that it waits for its planet. */
function fromLine(row: LandmarkRow): string {
  return row.planet ? `from ${row.planet.name} · ${row.finish.toLowerCase()}` : `${row.finish} · waits for its planet`;
}

/**
 * The landmark card (V3 Scrolls p6, "Universe · afterwards"; D-089, D-214): a paper card over the bottom of the
 * map with the newest landmark, where it came from, "See it", the week's Orbit as one line of text and the next
 * Part as a yellow chip. It replaces the chips the map once carried; nothing of it is drawn on the map itself.
 * While a globe or a landed map is on screen it folds to one line, so it never covers a planet's or region's name.
 * Without a landmark it speaks of the next Part, or of the week. Never shown on a friend's universe.
 */
export function LandmarkCard({
  view,
  folded,
  onSee,
}: {
  readonly view: CollectionView;
  /** One line only: a globe or a landed map is in view. */
  readonly folded: boolean;
  /** Opens the list of landmarks. */
  readonly onSee: () => void;
}) {
  const subject = cardSubjectOf(view);
  if (subject === undefined) return null;
  return folded ? (
    <FoldedLandmark view={view} subject={subject} onSee={onSee} />
  ) : (
    <OpenLandmark view={view} subject={subject} onSee={onSee} />
  );
}

function useResume(view: CollectionView): (() => void) | undefined {
  const router = useRouter();
  const { resume } = view;
  return resume ? () => router.push({ pathname: '/scroll/[assetId]', params: { assetId: resume.assetId } }) : undefined;
}

/** The yellow "Resume Part 2 of 3" chip: the one yellow thing on the card, as yellow means continuation. */
function ResumeChip({ resume, onPress }: { readonly resume: ResumeOffer; readonly onPress: () => void }) {
  const focus = useFocusRing('onLight');
  return (
    <Pressable
      testID="universe-resume"
      accessibilityRole="button"
      accessibilityLabel={`${resumeLabel(resume.part, resume.total)}: ${resume.title}`}
      onPress={onPress}
      {...focus.props}
      style={[styles.resume, focus.style]}
    >
      <Icon name="play" size={14} color={PAPER_INK} />
      <Text variant="uiS" color={PAPER_INK}>
        {resumeLabel(resume.part, resume.total)}
      </Text>
    </Pressable>
  );
}

function OpenLandmark({
  view,
  subject,
  onSee,
}: {
  readonly view: CollectionView;
  readonly subject: CardSubject;
  readonly onSee: () => void;
}) {
  const { breakpoint } = useDisplay();
  const resumeNow = useResume(view);
  const [newest] = view.rows;
  const { resume, orbitText } = view;
  const heading = subject === 'landmark' ? landmarkHeading(newest!) : subject === 'resume' ? 'Next part' : 'This week';
  const title = newest && subject === 'landmark' ? newest.name : subject === 'resume' ? resume!.title : orbitText!;
  const line =
    newest && subject === 'landmark'
      ? fromLine(newest)
      : subject === 'resume'
        ? `Part ${String(resume!.part)} of ${String(resume!.total)}`
        : '';
  return (
    <View
      testID="universe-landmark-card"
      role="status"
      // On desktop the key hints sit at the bottom right of the map, so the card keeps to the left.
      style={[styles.card, breakpoint === 'desktop' ? styles.cardLeft : null]}
    >
      <View style={styles.cardRow}>
        <View style={[styles.cardBadge, newest?.tier === 'plain' ? styles.cardBadgePlain : null]} aria-hidden>
          <Icon name="flag" size={20} color={PAPER_INK} />
        </View>
        <View style={styles.cardText}>
          <Text variant="label" color={PAPER_INK2}>
            {heading}
          </Text>
          {/* A long name wraps to a second line; only a name longer than two lines is cut (#648). */}
          <Text variant="title" heading={2} color={PAPER_INK} numberOfLines={2} testID="universe-landmark-title">
            {title}
          </Text>
          {line ? (
            <Text variant="bodyS" color={PAPER_INK2} numberOfLines={2} testID="universe-landmark-line">
              {line}
            </Text>
          ) : null}
        </View>
        {subject === 'landmark' ? (
          // The name holds the visible words (WCAG 2.5.3) and says what opens.
          <Button label="See it" variant="ink" size="sm" accessibilityLabel="See it, your landmarks" onPress={onSee} />
        ) : subject === 'resume' && resumeNow ? (
          <Button
            label="Resume"
            variant="ink"
            size="sm"
            accessibilityLabel={`${resumeLabel(resume!.part, resume!.total)}: ${resume!.title}`}
            onPress={resumeNow}
          />
        ) : null}
      </View>
      {subject === 'landmark' && (orbitText || resume) ? (
        <View style={styles.cardFoot}>
          {resume && resumeNow ? <ResumeChip resume={resume} onPress={resumeNow} /> : null}
          {orbitText ? (
            <Text variant="meta" color={PAPER_INK2} testID="universe-orbit">
              {orbitText}
            </Text>
          ) : null}
        </View>
      ) : subject === 'resume' && orbitText ? (
        <Text variant="meta" color={PAPER_INK2} testID="universe-orbit">
          {orbitText}
        </Text>
      ) : null}
    </View>
  );
}

/** The one-line form: a paper pill that opens the list, or resumes when the next Part is all there is. */
function FoldedLandmark({
  view,
  subject,
  onSee,
}: {
  readonly view: CollectionView;
  readonly subject: CardSubject;
  readonly onSee: () => void;
}) {
  const focus = useFocusRing('onLight');
  const resumeNow = useResume(view);
  const [newest] = view.rows;
  const { resume, orbitText } = view;
  const resuming = subject === 'resume' && resumeNow !== undefined;
  const text =
    subject === 'landmark'
      ? `${landmarkHeading(newest!)} · ${newest!.name}`
      : subject === 'resume'
        ? resumeLabel(resume!.part, resume!.total)
        : orbitText!;
  return (
    <Pressable
      testID="universe-landmark-chip"
      accessibilityRole="button"
      accessibilityLabel={
        resuming ? `${text}: ${resume!.title}` : subject === 'landmark' ? `${text}. See your landmarks` : text
      }
      onPress={resuming ? resumeNow : onSee}
      {...focus.props}
      style={[styles.chip, resuming ? styles.chipResume : null, focus.style]}
    >
      <Icon name={resuming ? 'play' : 'flag'} size={16} color={PAPER_INK} />
      <Text variant="uiS" color={PAPER_INK} numberOfLines={1} style={styles.chipText}>
        {text}
      </Text>
    </Pressable>
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
  const resumeNow = useResume(view);
  return (
    <View testID="universe-collection-sheet" role="dialog" accessibilityLabel="Landmarks" style={styles.sheet}>
      <View style={styles.sheetHead}>
        <Text variant="title" heading={2} color="#ffffff">
          {view.rows.length > 0 ? `Landmarks · ${String(view.rows.length)}` : 'This week'}
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
      {view.resume && resumeNow ? (
        <View style={styles.sheetResume}>
          <ResumeChip resume={view.resume} onPress={resumeNow} />
        </View>
      ) : null}
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
  card: {
    gap: spacing[3],
    backgroundColor: PAPER,
    borderRadius: 24,
    padding: spacing[3],
    maxWidth: 460,
    width: '100%',
    alignSelf: 'center',
  },
  cardLeft: { alignSelf: 'flex-start', maxWidth: 440 },
  cardRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  cardText: { flex: 1, minWidth: 0, gap: 2 },
  cardFoot: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: spacing[3], paddingLeft: spacing[1] },
  cardBadge: {
    width: 44,
    height: 44,
    borderRadius: 22,
    borderWidth: 2,
    borderColor: PAPER_INK,
    backgroundColor: GOLD,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cardBadgePlain: { backgroundColor: PAPER_TOP },
  resume: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing[2],
    minHeight: 36,
    paddingHorizontal: spacing[3],
    borderRadius: radius.pill,
    backgroundColor: space.focus,
    cursor: 'pointer' as const,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: spacing[2],
    minHeight: 44,
    maxWidth: '100%',
    paddingHorizontal: spacing[4],
    borderRadius: radius.pill,
    backgroundColor: PAPER,
    cursor: 'pointer' as const,
  },
  chipResume: { backgroundColor: space.focus },
  chipText: { flexShrink: 1 },
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
  sheetResume: { alignItems: 'flex-start' },
  sheetRows: { gap: spacing[2] },
  sheetRow: { flexDirection: 'row', alignItems: 'center', gap: spacing[3] },
  sheetRowText: { flex: 1 },
  badge: { width: 14, height: 14, borderRadius: radius.pill, borderWidth: 2, borderColor: '#15302a' },
  gold: { backgroundColor: GOLD },
  plain: { backgroundColor: '#fffdf2' },
  section: { gap: spacing[2], marginTop: spacing[3] },
});

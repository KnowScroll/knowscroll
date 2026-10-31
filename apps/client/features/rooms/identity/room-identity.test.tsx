import type * as React from 'react';
import { StyleSheet, Text as NativeText } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { ROOM_MOTIONS, ROOM_SWATCHES, type RoomIdentity, type RoomKit, type RoomListItem } from '@knowscroll/contracts';
import { DisplayProvider } from '@knowscroll/ui';
import { BandTag } from './band-tag';
import { useBandTone } from './band-tone';
import { RoomBandView } from './room-band';
import { RoomEmblem, ResidentMark } from './room-emblem';
import { ResidentHeader } from '../resident-message';
import { RoomRow } from '../room-row';

jest.mock('expo-router', () => ({
  useRouter: () => ({ navigate: jest.fn(), push: jest.fn(), replace: jest.fn(), canGoBack: () => false }),
}));

/** A labelled fixture kit: words from the closed vocabulary, never provider output. */
const kit: RoomKit = {
  version: 'station-kit.v1',
  palette: { ground: 'paper', accent: 'rust', ink: 'soot' },
  emblem: { frame: 'arch', glyph: 'hourglass' },
  motif: 'chalk-lines',
  motion: 'pan',
  cast: { explainer: 'book', skeptic: 'gear' },
};
const identity: RoomIdentity = { kit };

const wrap = (node: React.ReactNode, reducedMotion = false) =>
  render(<DisplayProvider value={{ width: 390, textScale: 1, reducedMotion }}>{node}</DisplayProvider>);

/** The art is hidden from screen readers on purpose, so these reads ask for hidden elements too. */
const art = (testID: string) => screen.getByTestId(testID, { includeHiddenElements: true });
const maybeArt = (testID: string) => screen.queryByTestId(testID, { includeHiddenElements: true });

function Probe() {
  const tone = useBandTone();
  return <NativeText testID="tone">{`${tone.ground}|${tone.ink}`}</NativeText>;
}

describe('the band of a room', () => {
  it('is the kit’s ground with its pattern, and what stands on it reads the kit’s ink', async () => {
    await wrap(
      <RoomBandView kit={kit} reducedMotion={false} testID="band">
        <Probe />
        <BandTag label="Open to everyone" />
      </RoomBandView>,
    );
    expect(StyleSheet.flatten(screen.getByTestId('band').props.style as object)).toMatchObject({
      backgroundColor: ROOM_SWATCHES.paper,
    });
    expect(art('room-motif')).toBeTruthy();
    expect(screen.getByTestId('tone').props.children).toBe(`${ROOM_SWATCHES.paper}|${ROOM_SWATCHES.soot}`);
    expect(screen.getByLabelText('Open to everyone')).toBeTruthy();
  });

  it('keeps the dark space band a room without a face always had', async () => {
    await wrap(
      <RoomBandView kit={undefined} reducedMotion={false} testID="band">
        <Probe />
      </RoomBandView>,
    );
    expect(maybeArt('room-motif')).toBeNull();
    expect(screen.getByTestId('tone').props.children).toBe('#040A17|#FFFBF0');
  });

  it.each(ROOM_MOTIONS)('stands still under reduced motion and moves otherwise: %s', async (motion) => {
    const moving = await wrap(
      <RoomBandView kit={{ ...kit, motion }} reducedMotion={false}>
        <Probe />
      </RoomBandView>,
    );
    const animated = StyleSheet.flatten(art('room-motif').props.style as object) as {
      opacity?: unknown;
      transform?: unknown;
    };
    // Every loop drives opacity or a transform; none of it is a number at rest.
    expect(animated.opacity !== undefined || animated.transform !== undefined).toBe(true);
    await moving.unmount();

    await wrap(
      <RoomBandView kit={{ ...kit, motion }} reducedMotion>
        <Probe />
      </RoomBandView>,
      true,
    );
    const still = StyleSheet.flatten(art('room-motif').props.style as object) as {
      opacity?: unknown;
      transform?: unknown;
    };
    expect(still.opacity).toBeUndefined();
    expect(still.transform).toBeUndefined();
  });

  it('draws the painted backdrop only when one is given, under a wash of the ground', async () => {
    await wrap(
      <RoomBandView
        kit={kit}
        reducedMotion
        backdrop={{ uri: 'https://app.test/media/room/ab', headers: { authorization: 'Bearer x' } }}
      >
        <Probe />
      </RoomBandView>,
    );
    expect(art('room-backdrop').props.source).toMatchObject({ uri: 'https://app.test/media/room/ab' });
    expect(art('room-motif')).toBeTruthy();
  });

  it('keeps the outer tenth of the backdrop outside the band, where the image model signs its prints', async () => {
    await wrap(
      <RoomBandView kit={kit} reducedMotion backdrop={{ uri: 'https://app.test/media/room/ab' }}>
        <Probe />
      </RoomBandView>,
    );
    const picture = StyleSheet.flatten(art('room-backdrop').props.style as object) as { transform?: unknown };
    expect(picture.transform).toEqual([{ scale: 1.25 }]);
    // The zoom only hides the edges when the band clips what it enlarges.
    const clip = StyleSheet.flatten(art('room-art').props.style as object) as { overflow?: unknown };
    expect(clip.overflow).toBe('hidden');
  });

  it('draws no backdrop where none was approved', async () => {
    await wrap(
      <RoomBandView kit={kit} reducedMotion>
        <Probe />
      </RoomBandView>,
    );
    expect(maybeArt('room-backdrop')).toBeNull();
  });
});

describe('the emblem and the residents’ marks', () => {
  it('is a picture beside a name, hidden from screen readers', async () => {
    await wrap(<RoomEmblem kit={kit} size={36} testID="emblem" />);
    expect(art('emblem').props['aria-hidden']).toBe(true);
  });

  it('puts a mark on each resident that is never a face, and keeps the AI label that carries the meaning', async () => {
    await wrap(
      <>
        <ResidentHeader
          name="Nova"
          label="AI · Explainer"
          suggestion="explanation"
          trigger={undefined}
          kit={kit}
          inhabitant="explainer"
        />
        <ResidentMark kit={kit} resident="skeptic" testID="skeptic-mark" />
      </>,
    );
    expect(art('resident-mark')).toBeTruthy();
    expect(screen.getByLabelText('AI, Explainer')).toBeTruthy();
    expect(screen.getByText('Nova')).toBeTruthy();
    expect(art('skeptic-mark').props['aria-hidden']).toBe(true);
  });

  it('draws no mark for a room without a face', async () => {
    await wrap(<ResidentHeader name="Nova" label="AI · Explainer" suggestion={undefined} trigger={undefined} />);
    expect(maybeArt('resident-mark')).toBeNull();
    expect(screen.getByLabelText('AI, Explainer')).toBeTruthy();
  });
});

describe('a room in Talk', () => {
  const item = (withFace: boolean): RoomListItem => ({
    standing: 'member',
    room: {
      roomId: '0199d000-0000-7000-8000-000000000001',
      name: 'History room',
      description: 'The past.',
      topic: { kind: 'system', id: 'history', label: 'History' },
      joinRule: 'open',
      status: 'open',
      ...(withFace ? { identity } : {}),
    },
  });

  it('wears its emblem in its row, and an older server’s room keeps the planet tile', async () => {
    await wrap(<RoomRow item={item(true)} />);
    expect(art('talk-room-emblem-0199d000-0000-7000-8000-000000000001')).toBeTruthy();
  });

  it('keeps the plain tile where no face was sent', async () => {
    await wrap(<RoomRow item={item(false)} />);
    expect(maybeArt('talk-room-emblem-0199d000-0000-7000-8000-000000000001')).toBeNull();
    expect(screen.getByLabelText(/Room History room/)).toBeTruthy();
  });
});

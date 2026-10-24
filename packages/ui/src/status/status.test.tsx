import { fireEvent, screen } from '@testing-library/react-native';
import { status } from '@knowscroll/design-tokens';
import { renderOn } from '../test-support/render';
import { Banner } from './banner';
import { Skeleton } from './skeleton';
import { ErrorState, OfflineState, StateBlock } from './state-block';
import { Tag } from './tag';

describe('Tag', () => {
  it('is a non-interactive label read in words', async () => {
    await renderOn(<Tag label="Corrected · 14 Oct" variant="corrected" />);
    expect(screen.getByRole('text', { name: 'Corrected, 14 Oct' })).toBeOnTheScreen();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('draws Hypothetical with the dashed cobalt edge and Corrected in rust', async () => {
    await renderOn(
      <>
        <Tag label="Hypothetical" variant="hypothetical" testID="hypothetical" />
        <Tag label="Corrected" variant="corrected" testID="corrected" />
      </>,
    );
    expect(screen.getByTestId('hypothetical')).toHaveStyle({
      borderStyle: 'dashed',
      borderColor: status.hypothetical.edge,
    });
    expect(screen.getByTestId('corrected')).toHaveStyle({ borderStyle: 'solid', borderColor: status.corrected.edge });
  });

  it('renders caps at 100 % text and sentence case above 150 %', async () => {
    const view = await renderOn(<Tag label="Part 2 of 3" variant="part" />);
    expect(screen.getByText('Part 2 of 3', { includeHiddenElements: true })).toHaveStyle({
      textTransform: 'uppercase',
    });
    await view.unmount();
    await renderOn(<Tag label="Part 2 of 3" variant="part" />, { textScale: 1.75 });
    expect(screen.getByText('Part 2 of 3', { includeHiddenElements: true })).toHaveStyle({
      textTransform: 'none',
      fontFamily: 'InstrumentSans',
    });
  });
});

describe('Banner', () => {
  it('announces offline and reconnecting politely as a status', async () => {
    await renderOn(<Banner kind="offline" lead="Offline." message="Your place is kept." testID="banner" />);
    expect(screen.getByTestId('banner')).toHaveProp('role', 'status');
    expect(screen.getByTestId('banner')).toHaveProp('accessibilityLiveRegion', 'polite');
    expect(screen.getByLabelText('Offline. Your place is kept.')).toBeOnTheScreen();
  });

  it('announces an error as an alert', async () => {
    await renderOn(<Banner kind="error" lead="Couldn't load." message="Nothing was changed." testID="banner" />);
    expect(screen.getByTestId('banner')).toHaveProp('role', 'alert');
  });

  it('is not a live region for a correction, and offers its action', async () => {
    const onPress = jest.fn();
    await renderOn(
      <Banner
        kind="corrected"
        lead="Corrected 14 Oct."
        message="One claim was revised."
        action={{ label: 'What changed', onPress }}
        testID="banner"
      />,
    );

    await fireEvent.press(screen.getByRole('button', { name: 'What changed' }));

    expect(screen.getByTestId('banner')).not.toHaveProp('role');
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('has a plain notice kind that is not a live region', async () => {
    await renderOn(
      <Banner kind="info" lead="Sign-in isn't available yet." message="This build has no accounts." testID="banner" />,
    );
    expect(screen.getByTestId('banner')).not.toHaveProp('role');
  });

  it('gives its inline action a 44 px target', async () => {
    await renderOn(
      <Banner
        kind="recordingPaused"
        lead="Recording paused."
        message="…"
        action={{ label: 'Resume', onPress: () => undefined }}
      />,
    );
    expect(screen.getByRole('button', { name: 'Resume' })).toHaveStyle({ minHeight: 44, minWidth: 44 });
  });
});

describe('Skeleton', () => {
  it('is one busy progress region with a name, not a stack of anonymous boxes', async () => {
    await renderOn(<Skeleton rows={2} label="Loading Keep" />);
    const region = screen.getByRole('progressbar', { name: 'Loading Keep' });
    expect(region).toBeBusy();
  });
});

describe('StateBlock', () => {
  it('has a heading, one calm sentence and only the actions it is given', async () => {
    const onPress = jest.fn();
    await renderOn(
      <StateBlock
        title="Nothing kept yet"
        body="Tap Save on any Reel or Scroll."
        actions={[{ label: 'Go to Explore', role: 'link', onPress }]}
      />,
    );

    await fireEvent.press(screen.getByRole('link', { name: 'Go to Explore' }));

    expect(screen.getByRole('header', { name: 'Nothing kept yet' })).toBeOnTheScreen();
    expect(screen.getAllByRole(/^(button|link)$/)).toHaveLength(1);
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('offers Try again in the offline and error blocks only when a retry exists', async () => {
    const onRetry = jest.fn();
    const view = await renderOn(<OfflineState body="This list may be out of date." onRetry={onRetry} />);
    await fireEvent.press(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('header', { name: "You're offline" })).toBeOnTheScreen();
    await view.unmount();

    await renderOn(<ErrorState title="Couldn't load Keep" body="Nothing was changed." />);
    expect(screen.getByRole('header', { name: "Couldn't load Keep" })).toBeOnTheScreen();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('lists what else works offline after Try again', async () => {
    const keep = jest.fn();
    await renderOn(
      <OfflineState
        body="Your place is kept."
        onRetry={jest.fn()}
        more={[{ label: 'Open something you kept', onPress: keep, variant: 'default' }]}
      />,
    );
    const names = screen.getAllByRole('button').map((button) => button.props.accessibilityLabel as string);
    expect(names).toEqual(['Try again', 'Open something you kept']);
    await fireEvent.press(screen.getByRole('button', { name: 'Open something you kept' }));
    expect(keep).toHaveBeenCalledTimes(1);
  });
});

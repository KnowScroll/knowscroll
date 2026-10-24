import { render, screen } from '@testing-library/react-native';
import { DisplayProvider } from '@knowscroll/ui';
import { AssumptionChips } from './assumption-chips';

const axis = { subject: 'Axis tilt', statement: 'Earth’s axis is tilted' };
const spin = { subject: 'Spin', statement: 'Earth turns once a day' };
const gravity = { subject: 'Gravity', statement: 'Gravity pushes away from the Sun', replaces: 'axis tilt' };

const show = (option: Parameters<typeof AssumptionChips>[0]['option'], premises?: (typeof axis)[]) =>
  render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <AssumptionChips option={option} {...(premises === undefined ? {} : { premises })} />
    </DisplayProvider>,
  );

describe('what an idea would take out', () => {
  it('says, in the premise’s own words, which one a change replaces, whatever the change’s subject', async () => {
    await show({ changes: [gravity], kept: [] }, [axis, spin]);
    expect(screen.getByText('Changed: gravity pushes away from the Sun')).toBeOnTheScreen();
    expect(screen.getByText('Replaces: earth’s axis is tilted')).toBeOnTheScreen();
    expect(screen.queryByText(/Replaces: earth turns/)).toBeNull();
    expect(
      screen.getByLabelText('Changed: gravity pushes away from the Sun. Replaces: earth’s axis is tilted.'),
    ).toBeOnTheScreen();
  });

  it('says it too when a change takes the place of the premise of its own subject', async () => {
    await show({ changes: [{ subject: 'spin', statement: 'Earth turns twice a day' }], kept: [] }, [axis, spin]);
    expect(screen.getByText('Replaces: earth turns once a day')).toBeOnTheScreen();
  });

  it('says nothing of replacing when nothing is taken out: on the real subject, or beside what holds', async () => {
    await show({ changes: [gravity], kept: [] });
    expect(screen.queryByText(/Replaces:/)).toBeNull();
    await screen.unmount();
    await show({ changes: [{ subject: 'Moon', statement: 'Earth has a second moon' }], kept: [] }, [axis, spin]);
    expect(screen.queryByText(/Replaces:/)).toBeNull();
  });
});

import { render, screen, fireEvent, waitFor } from '@testing-library/react-native';
import { UniverseMap } from './universe-map';
import { createUniverseViewSession } from './universe-session';
import { fixtureId, universeHarness } from './universe.fixture';
it('draws only canonical scene targets and bounds dense geometry without hiding the outline route', async () => {
  const h = universeHarness(1000),
    s = createUniverseViewSession(h.scope);
  s.setForeground(true);
  await waitFor(() => expect(s.getState().read.status).toBe('ready'));
  s.focus(fixtureId(10));
  s.camera({ x: 4000, y: 4000, scale: 0.125 });
  const view = await render(<UniverseMap session={s} state={s.getState()} />);
  expect(screen.getAllByTestId(/^universe-focus-/).length).toBeLessThanOrEqual(64);
  expect(screen.getByText('Map view is crowded. Use the outline to reach every place.')).toBeOnTheScreen();
  expect(s.cacheSize()).toBeLessThanOrEqual(128);
  await fireEvent.press(screen.getByRole('button', { name: 'Zoom in' }));
  expect(s.getState().frame.scale).toBe(0.15625);
  await view.unmount();
  h.scope.end();
});
it('low detail preserves actual targets and ordinary touch labels', async () => {
  const h = universeHarness(),
    s = createUniverseViewSession(h.scope);
  s.setForeground(true);
  await waitFor(() => expect(s.getState().read.status).toBe('ready'));
  const v = await render(<UniverseMap session={s} state={s.getState()} />);
  await fireEvent.press(screen.getByRole('button', { name: 'Focus CI system 0, system' }));
  expect(s.getState().focusId).toBe(fixtureId(10));
  await v.unmount();
  h.scope.end();
});

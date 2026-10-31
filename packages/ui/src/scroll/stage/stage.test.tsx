import { render, screen } from '@testing-library/react-native';
import seasons from '@knowscroll/scroll-model/fixtures/seasons-stage-ci.json';
import type { ScrollDocumentV2 } from '@knowscroll/scroll-model';
import { Stage } from './stage';

const document = seasons as unknown as ScrollDocumentV2;
const stage = document.stage;
if (stage === undefined) throw new Error('the fixture has a stage');
const props = { document: { stops: document.stops, stage }, stopId: 'final-tilt', reducedMotion: true, height: 240 };

/** The pinned stage at the Final call, over the labelled CI fixture, with the tilt the reader has turned it to. */
describe('the stage at a tilt the reader has turned (D-187)', () => {
  it("names the picture for a screen reader by the tilt it is turned to, and by the state at today's tilt", async () => {
    const view = await render(<Stage {...props} />);
    expect(screen.getByLabelText(/tilted by 23.4 degrees/)).toBeOnTheScreen();
    await view.rerender(<Stage {...props} tilt={0} />);
    expect(screen.getByLabelText(/stands straight up/)).toBeOnTheScreen();
    await view.rerender(<Stage {...props} tilt={60} />);
    expect(screen.getByLabelText(/tilted by 60 degrees/)).toBeOnTheScreen();
    await view.rerender(<Stage {...props} tilt={23.4} />);
    expect(screen.getByLabelText(/tilted by 23.4 degrees/)).toBeOnTheScreen();
  });

  it('redraws the one picture for each step of the slider and never replaces it', async () => {
    const view = await render(<Stage {...props} tilt={10} />);
    const drawing = screen.getByLabelText(/Earth circles the Sun/).children[0];
    expect(drawing).toBeDefined();
    for (const tilt of [11, 12, 40, 0, 90]) {
      await view.rerender(<Stage {...props} tilt={tilt} />);
      expect(screen.getByLabelText(/Earth circles the Sun/).children[0]).toBe(drawing);
    }
  });
});

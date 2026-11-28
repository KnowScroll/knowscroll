import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { GROUND_LABEL, groundLabelWidth, LABEL_HEIGHT, labelWidth, MapLabel } from './scene-parts';

const placed = (width: number, height: number) => ({ id: 'r', x: 20, y: 30, width, height });
const textStyle = (node: ReturnType<typeof screen.getByText>) =>
  StyleSheet.flatten(node.props.style) as Record<string, unknown>;

describe('a name on the ground', () => {
  it('is heavier and larger than a name on land from orbit, with a stronger halo', async () => {
    await render(<MapLabel label={placed(120, 24)} text="CI region 7" variant="land" />);
    const land = textStyle(screen.getByText('CI region 7'));
    await screen.unmount();
    await render(<MapLabel label={placed(120, 24)} text="CI region 7" variant="ground" />);
    const copies = screen.getAllByText('CI region 7', { includeHiddenElements: true });
    // The name and a second copy under it that carries the wider halo, hidden from assistive technology.
    expect(copies).toHaveLength(2);
    expect(screen.getAllByText('CI region 7')).toHaveLength(1);
    const [halo, ground] = copies.map(textStyle) as [Record<string, number>, Record<string, number>];
    expect(Number(ground['fontSize'])).toBeGreaterThan(Number(land['fontSize'] ?? 13));
    expect(ground['fontWeight']).toBe('800');
    expect(Number(ground['fontWeight'])).toBeGreaterThan(Number(land['fontWeight']));
    expect(Number(ground['textShadowRadius'])).toBeGreaterThan(Number(land['textShadowRadius']));
    expect(Number(halo['textShadowRadius'])).toBeGreaterThan(Number(ground['textShadowRadius']));
    expect(ground['fontSize']).toBe(GROUND_LABEL.fontSize);
  });

  it('leaves a name on land from orbit as it was: one copy, no pill', async () => {
    await render(<MapLabel label={placed(80, 20)} text="CI region 7" variant="land" />);
    expect(screen.getAllByText('CI region 7', { includeHiddenElements: true })).toHaveLength(1);
  });

  it('has a box wider and taller than a plain name’s, so the heavier type is never cut', () => {
    for (const text of ['CI region 7', 'Machine learning', 'W', 'The Great Western Wall of Mirrors']) {
      expect(groundLabelWidth(text)).toBeGreaterThan(labelWidth(text));
    }
    expect(GROUND_LABEL.height).toBeGreaterThan(LABEL_HEIGHT);
    expect(GROUND_LABEL.height).toBeGreaterThanOrEqual(GROUND_LABEL.lineHeight);
    // 16 px Bricolage 800 sets "CI region 7" 82 px wide (measured in the browser): the box holds it with room to spare.
    expect(groundLabelWidth('CI region 7')).toBeGreaterThanOrEqual(82 + 12);
  });
});

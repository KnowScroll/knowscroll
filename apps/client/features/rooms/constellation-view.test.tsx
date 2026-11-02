import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { DisplayProvider } from '@knowscroll/ui';
import { ConstellationView } from './constellation-view';

const layout = (width: number) => ({ nativeEvent: { layout: { x: 0, y: 0, width, height: width * (168 / 288) } } });
const boxOf = (index: number) => {
  const style = StyleSheet.flatten(screen.getByTestId(`star-${String(index)}`).props.style as object) as {
    left: number;
    top: number;
    width: number;
    height: number;
  };
  return { left: style.left, top: style.top, right: style.left + style.width, bottom: style.top + style.height };
};

async function drawn(width: number) {
  await render(
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <ConstellationView lit={7} selected={undefined} onSelect={() => undefined} label="Constellation" />
    </DisplayProvider>,
  );
  await fireEvent(screen.getByTestId('constellation'), 'layout', layout(width));
}

describe('the constellation in a narrow column', () => {
  it.each([280, 288, 264])('keeps every star and its whole 44 px target inside an art %d px wide', async (width) => {
    await drawn(width);
    const height = width * (168 / 288);
    for (let index = 0; index < 7; index++) {
      const box = boxOf(index);
      const inside = box.left >= 0 && box.top >= 0 && box.right <= width && box.bottom <= height + 0.5;
      expect({ star: index, inside }).toEqual({ star: index, inside: true });
    }
  });

  it('keeps the stars in the order they were earned, from the left to the right edge of the arch', async () => {
    await drawn(280);
    expect(boxOf(0).left).toBeLessThan(boxOf(3).left);
    expect(boxOf(3).left).toBeLessThan(boxOf(6).left);
  });
});

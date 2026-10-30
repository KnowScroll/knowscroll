import { fireEvent, render, screen } from '@testing-library/react-native';
import type { SpaceDefinition } from './space-definition';
import { SpaceSimpleLists } from './space-simple-lists';

/** Many planets, so the list is longer than any screen and its last row can only be reached by scrolling. */
const long: SpaceDefinition = {
  camera: { position: [0, 0, 0], target: [0, 0, 0], drift: 0, fogRange: [1, 2] },
  systems: [
    {
      id: 'system',
      name: 'Long system',
      family: 'teal',
      position: { x: 0, z: 0 },
      sunRadius: 1,
      planetRadius: 0.3,
      speed: 0.1,
      orbitFalloff: 0.5,
      planets: Array.from({ length: 40 }, (_, index) => ({
        id: `planet-${index}`,
        name: `Planet ${index}`,
        type: 'lush' as const,
        orbitRadius: 2 + index * 0.1,
        startAngle: 0,
      })),
    },
  ],
  stations: [{ id: 'room', name: 'Last room', systemId: 'system', position: { x: 1, y: 0, z: 1 } }],
};

describe('the plain lists of a space', () => {
  it('leave room under the last row for the chips and the tab bar, and the last row still opens', async () => {
    const chosen: string[] = [];
    await render(
      <SpaceSimpleLists
        definition={long}
        onChoose={(choice) => chosen.push(`${choice.kind}:${choice.id}`)}
        insets={{ top: 140, bottom: 232 }}
      />,
    );
    const [, content] = screen.getByTestId('ks-space-simple').props.contentContainerStyle as [
      unknown,
      { paddingTop: number; paddingBottom: number },
    ];
    expect(content.paddingTop).toBe(140);
    expect(content.paddingBottom).toBe(232);
    // The last row is a real, named button at the end of the list.
    await fireEvent.press(screen.getByRole('button', { name: 'Last room, a room station' }));
    await fireEvent.press(screen.getByRole('button', { name: 'Planet 39, a planet in Long system' }));
    expect(chosen).toEqual(['station:room', 'planet:planet-39']);
  });

  it('lists the stations after the systems, under Rooms', async () => {
    await render(<SpaceSimpleLists definition={long} />);
    expect(screen.getByRole('header', { name: 'Rooms' })).toBeOnTheScreen();
  });
});

import { render, screen } from '@testing-library/react-native';
import { SpaceChip } from './space-chip';

const FILL = 'rgba(10,20,28,0.55)';
const chip = (props: Partial<Parameters<typeof SpaceChip>[0]> = {}) =>
  render(<SpaceChip label="List view" onPress={() => undefined} testID="chip" {...props} />);

describe('SpaceChip', () => {
  it('is a hairline ghost with no fill, as it always was', async () => {
    await chip();
    expect(screen.getByTestId('chip')).not.toHaveStyle({ backgroundColor: FILL });
    expect(screen.getByTestId('chip')).toHaveStyle({ borderWidth: 1 });
  });

  it('takes a dark glass fill on a ghost chip only when asked', async () => {
    await chip({ glass: true });
    expect(screen.getByTestId('chip')).toHaveStyle({ backgroundColor: FILL, borderWidth: 1 });
  });

  it('keeps a solid chip cream: glass changes only the ghost', async () => {
    await chip({ variant: 'solid', glass: true });
    expect(screen.getByTestId('chip')).not.toHaveStyle({ backgroundColor: FILL });
  });
});

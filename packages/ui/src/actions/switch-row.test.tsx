import { fireEvent, screen } from '@testing-library/react-native';
import { renderOn } from '../test-support/render';
import { SwitchRow } from './switch-row';

describe('SwitchRow', () => {
  it('is one switch named by its label, with its state', async () => {
    await renderOn(
      <SwitchRow label="Shape my universe" description="On: worlds can grow." on onChange={() => undefined} />,
    );
    expect(screen.getByRole('switch', { name: 'Shape my universe', checked: true })).toBeOnTheScreen();
    expect(screen.getByText('On: worlds can grow.')).toBeOnTheScreen();
  });

  it('asks for the other state when pressed', async () => {
    const onChange = jest.fn();
    await renderOn(<SwitchRow label="Notices" on={false} onChange={onChange} />);
    await fireEvent.press(screen.getByRole('switch', { name: 'Notices' }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does nothing while disabled', async () => {
    const onChange = jest.fn();
    await renderOn(<SwitchRow label="Notices" on={false} disabled onChange={onChange} />);
    await fireEvent.press(screen.getByRole('switch', { name: 'Notices' }));
    expect(onChange).not.toHaveBeenCalled();
  });
});

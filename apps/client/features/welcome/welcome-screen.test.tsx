import { render, screen } from '@testing-library/react-native';
import { WelcomeScreen } from './welcome-screen';

describe('WelcomeScreen', () => {
  it('shows the product name as the screen heading', async () => {
    await render(<WelcomeScreen />);
    expect(screen.getByRole('header', { name: 'KnowScroll' })).toBeTruthy();
  });

  it('sets the name in the bundled display font', async () => {
    await render(<WelcomeScreen />);
    expect(screen.getByText('KnowScroll')).toHaveStyle({ fontFamily: 'BricolageGrotesque' });
  });
});

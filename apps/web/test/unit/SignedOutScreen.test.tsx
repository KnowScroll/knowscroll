import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SignedOutScreen } from '../../src/components/SignedOutScreen.tsx';

/**
 * #135, ADR-0026/ADR-0034: the signed-out screen the app shows whenever the API answers 401 for
 * the universe/session (no cookie, revoked, deleted). One control only: request a sign-in link.
 * The response is deliberately indistinguishable regardless of the address (no account-existence
 * leak) -- this screen shows exactly one fixed message either way.
 */
describe('SignedOutScreen', () => {
  it('requests a sign-in link for the typed address and shows one fixed message', async () => {
    const postMagicLink = vi.fn(async () => {});
    render(<SignedOutScreen apiClient={{ postMagicLink }} />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'someone@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send sign-in link/i }));
    await waitFor(() => expect(postMagicLink).toHaveBeenCalledWith('someone@example.com'));
    expect(await screen.findByText('Check your email for a sign-in link')).toBeInTheDocument();
  });

  it('shows the identical fixed message for any address -- no account-existence leak', async () => {
    const postMagicLink = vi.fn(async () => {});
    render(<SignedOutScreen apiClient={{ postMagicLink }} />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'unknown-address@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send sign-in link/i }));
    expect(await screen.findByText('Check your email for a sign-in link')).toBeInTheDocument();
  });

  it('disables the form while the request is in flight', async () => {
    let resolveSend: () => void = () => {};
    const postMagicLink = vi.fn(() => new Promise<void>(resolve => { resolveSend = resolve; }));
    render(<SignedOutScreen apiClient={{ postMagicLink }} />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'me@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send sign-in link/i }));
    expect(screen.getByRole('button', { name: /sending|send sign-in link/i })).toBeDisabled();
    resolveSend();
    await screen.findByText('Check your email for a sign-in link');
  });

  it('shows an optional real message above the form (e.g. after account deletion or sign-out)', () => {
    render(<SignedOutScreen apiClient={{ postMagicLink: vi.fn() }} message="Your account and history were deleted." />);
    expect(screen.getByText('Your account and history were deleted.')).toBeInTheDocument();
  });

  it('a network failure shows a real, retryable error -- never the fixed success message', async () => {
    const postMagicLink = vi.fn(async () => {
      throw new Error('network down');
    });
    render(<SignedOutScreen apiClient={{ postMagicLink }} />);
    fireEvent.change(screen.getByLabelText(/email/i), { target: { value: 'me@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /send sign-in link/i }));
    await screen.findByRole('alert');
    expect(screen.queryByText('Check your email for a sign-in link')).not.toBeInTheDocument();
  });
});

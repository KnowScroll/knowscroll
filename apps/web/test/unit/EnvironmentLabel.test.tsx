/** #201 — Stage and Dev say so on every screen; live and local show nothing (Gate 1 mockup). */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EnvironmentLabel } from '../../src/components/EnvironmentLabel.tsx';

describe('EnvironmentLabel', () => {
  it('labels stage as a test universe', () => {
    render(<EnvironmentLabel world="stage" />);
    const label = screen.getByRole('note', { name: 'Environment' });
    expect(label).toHaveTextContent('STAGE');
    expect(label).toHaveTextContent('test universe');
  });

  it('labels dev as resettable', () => {
    render(<EnvironmentLabel world="dev" />);
    expect(screen.getByRole('note', { name: 'Environment' })).toHaveTextContent('DEV');
  });

  it.each(['live', 'local'] as const)('renders nothing for %s', (world) => {
    const { container } = render(<EnvironmentLabel world={world} />);
    expect(container).toBeEmptyDOMElement();
  });
});

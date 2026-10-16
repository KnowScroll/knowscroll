import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { EnvironmentLabel } from './components/EnvironmentLabel.tsx';
import { Root } from './Root.tsx';
import { currentWorld } from './world.ts';
import './styles.css';

const container = document.getElementById('root');
if (!container) throw new Error('Root element not found');

createRoot(container).render(
  <StrictMode>
    <EnvironmentLabel world={currentWorld()} />
    <Root />
  </StrictMode>,
);

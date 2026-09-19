import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

afterEach(() => {
  cleanup();
});

/** jsdom implements neither observer; component tests only need harmless no-op stand-ins. */
class StubObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (!('IntersectionObserver' in globalThis)) {
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = StubObserver;
}
if (!('ResizeObserver' in globalThis)) {
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = StubObserver;
}

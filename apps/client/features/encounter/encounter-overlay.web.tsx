import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { content, overlay } from '@knowscroll/design-tokens';

const candidates =
  'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
/**
 * Local dialog: keyboard focus stays inside and returns to the invoking control. History belongs to the Back adapter.
 * It is drawn into the document body, above the tab bar and rail, which sit in their own stacking contexts.
 */
export function EncounterOverlay({
  children,
  onClose,
  label = 'Your path',
  presentation = 'full',
}: {
  readonly children: ReactNode;
  readonly label?: string;
  readonly presentation?: 'full' | 'sheet';
  readonly onClose: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const first =
      host.current?.querySelector<HTMLElement>('textarea:not([disabled])') ??
      host.current?.querySelector<HTMLElement>(candidates);
    (first ?? host.current)?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return createPortal(
    <div
      ref={host}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      style={{
        position: 'fixed',
        display: 'flex',
        flexDirection: 'column',
        inset: 0,
        background: presentation === 'sheet' ? overlay.scrim : content.paper,
        zIndex: 1000,
      }}
      onClick={(event) => {
        if (presentation === 'sheet' && event.target === event.currentTarget) onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          onClose();
          return;
        }
        if (event.key !== 'Tab') return;
        const nodes = [...(host.current?.querySelectorAll<HTMLElement>(candidates) ?? [])].filter(
          (node) => node.getClientRects().length > 0,
        );
        const first = nodes[0];
        const last = nodes.at(-1);
        if (!first || !last) {
          event.preventDefault();
          host.current?.focus();
          return;
        }
        if (event.shiftKey && (document.activeElement === first || document.activeElement === host.current)) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

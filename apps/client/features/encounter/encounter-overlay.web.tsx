import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { content } from '@knowscroll/design-tokens';

const candidates =
  'button:not([disabled]),a[href],input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"])';
/** Local dialog: keyboard focus stays inside and returns to the invoking control. History belongs to the Back adapter. */
export function EncounterOverlay({
  children,
  onClose,
  label = 'Your path',
}: {
  readonly children: ReactNode;
  readonly label?: string;
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
  return (
    <div
      ref={host}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      tabIndex={-1}
      style={{ position: 'fixed', inset: 0, background: content.paper, zIndex: 1000 }}
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
    </div>
  );
}

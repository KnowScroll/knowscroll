import type { ReactNode } from 'react';

/**
 * Web: the focus group the keys belong to (D-053, D-134). A key acts only while the group itself has
 * focus (Tab to it or click it), never on the whole page, so no single-character key can fire from
 * anywhere else (WCAG 2.1.4). A control inside keeps its own keys: Enter and Space on a button press
 * that button. Alt, Ctrl and Cmd are the browser's and the person's own.
 */
export function ReaderFocus<Key>({
  children,
  keyOf,
  onKey,
}: {
  readonly children: ReactNode;
  /** What a key means to this reader, or nothing (the browser keeps it). */
  readonly keyOf: (key: string, shift: boolean) => Key | undefined;
  readonly onKey: (key: Key) => boolean;
}) {
  return (
    <div
      data-testid="scroll-reader"
      role="group"
      aria-label="Scroll reader"
      tabIndex={0}
      style={{ display: 'flex', flex: 1, minHeight: 0, minWidth: 0, flexDirection: 'column', outlineOffset: -3 }}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || event.altKey || event.ctrlKey || event.metaKey) return;
        const key = keyOf(event.key, event.shiftKey);
        if (key !== undefined && onKey(key)) event.preventDefault();
      }}
    >
      {children}
    </div>
  );
}

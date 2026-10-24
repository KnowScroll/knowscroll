/**
 * The one ReactDOM call the web encounter overlay makes (a portal into the document body). ReactDOM
 * is already an app dependency; this narrow declaration avoids adding its types package for it.
 */
declare module 'react-dom' {
  import type { ReactNode } from 'react';
  export function createPortal(children: ReactNode, container: Element): ReactNode;
}

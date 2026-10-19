import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';

/**
 * Web: each screen names the page (WCAG 2.4.2), so a route change is announced as a new page and
 * history and tabs show where they lead. Set when the screen gains focus (tabs stay mounted).
 */
export function useDocumentTitle(title: string): void {
  useFocusEffect(
    useCallback(() => {
      document.title = `${title} · KnowScroll`;
    }, [title]),
  );
}

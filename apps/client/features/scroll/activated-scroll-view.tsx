import { useMemo, type ReactNode, type Ref } from 'react';
import { createScopedBlockStateStore, type AccountScope, type ReadingObserver } from '@knowscroll/client-core';
import { ScrollArticle, type ScrollLocalPosition, type ScrollPositionHandle } from '@knowscroll/ui';
import type { OpenedScroll } from './scroll-session';

/** Rendering an already activated exposure never performs an open or activation command. */
export function ActivatedScrollView({
  scope,
  scroll,
  observer,
  positionRef,
  initialPosition,
  paused,
  onPositionChange,
  afterHeader,
  endSlot,
  topInset,
  bottomInset,
  readingBottomInset = 0,
  anchorBlockId,
}: {
  readonly scope: AccountScope;
  readonly scroll: OpenedScroll;
  readonly observer: ReadingObserver;
  readonly positionRef?: Ref<ScrollPositionHandle>;
  readonly initialPosition?: ScrollLocalPosition;
  readonly anchorBlockId?: string;
  readonly paused?: boolean;
  readonly onPositionChange?: (position: ScrollLocalPosition) => void;
  readonly afterHeader?: ReactNode;
  readonly endSlot?: ReactNode;
  readonly topInset: number;
  readonly bottomInset: number;
  readonly readingBottomInset?: number;
}) {
  const store = useMemo(() => createScopedBlockStateStore(scope.storage), [scope]);
  return (
    <ScrollArticle
      document={scroll.document}
      store={store}
      observer={observer}
      positionRef={positionRef}
      onPositionChange={onPositionChange}
      initialPosition={initialPosition}
      anchorBlockId={anchorBlockId}
      paused={paused}
      afterHeader={afterHeader}
      endSlot={endSlot}
      testID="scroll-article"
      contentInset={{ top: topInset, bottom: bottomInset }}
      readingInset={{ top: topInset, bottom: readingBottomInset }}
    />
  );
}

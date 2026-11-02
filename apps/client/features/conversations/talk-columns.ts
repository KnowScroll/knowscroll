import { layout } from '@knowscroll/design-tokens';
import { CHAT_RAIL_WIDTH } from './chat-rail';
import { PANE_LIST_WIDTH } from './conversations-screen';

/** The narrowest the conversation itself may get before a side column is dropped. */
export const CHAT_MIN_WIDTH = 400;

/** The width of Talk's list column beside a conversation or thread (its pane and its gutters). */
export const LIST_COLUMN_WIDTH = PANE_LIST_WIDTH + 2 * layout.gutter;

/**
 * A desktop thread draws Talk's list as its first column only from this window width (D-327). Beside the list and the
 * series panel (400 px) the chat then keeps about 370 px or more; narrower windows keep the thread as it was.
 */
export const THREAD_LIST_MIN_WIDTH = 1280;

/** True when a thread has room for Talk's list as its first column. */
export const threadHasList = (width: number): boolean => width >= THREAD_LIST_MIN_WIDTH;

/**
 * True when a desktop conversation has room for the "In this chat" rail: the window minus the navigation rail, the list
 * and the rail still leaves the chat `CHAT_MIN_WIDTH` (D-328). Narrower windows keep the conversation and its list.
 */
export const conversationHasRail = (width: number): boolean =>
  width - layout.railDesktop - LIST_COLUMN_WIDTH - CHAT_RAIL_WIDTH >= CHAT_MIN_WIDTH;

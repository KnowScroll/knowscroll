import { useRouter } from 'expo-router';
import { useState } from 'react';
import {
  quietOffer,
  type AccountScope,
  type RoomReplayController,
  type RoomReplayState,
} from '@knowscroll/client-core';
import type { RoomView } from '@knowscroll/contracts';
import { closeThen } from '../../platform/close-then';
import { discussionHref } from './room-links';
import { useNow } from './use-now';
import { useRoomReplay } from './use-replay';

type Member = Extract<RoomView, { status: 'member' }>;

/**
 * Where a put-away offer is remembered: the account scope's own storage, under the room and the night the offer was for ("I'll only
 * offer once", R3 F). It goes with the scope when the account switches, the person signs out or a Clear changes the epoch.
 */
const offerKey = (roomId: string, day: string): string => `quiet-offer.${roomId}.${day}`;

export interface QuietRoom {
  /** The host's offer to replay a real Launch, while the room is quiet and the offer was not put away. */
  readonly offer: { readonly key: string; readonly line: string } | undefined;
  /** Puts the offer for this night away in this room. */
  readonly putOfferAway: (day: string) => void;
  readonly replay: {
    readonly open: boolean;
    readonly setOpen: (open: boolean) => void;
    readonly controller: RoomReplayController;
    readonly state: RoomReplayState;
  };
  readonly questions: { readonly open: boolean; readonly setOpen: (open: boolean) => void };
  /** Opens a question's discussion; from the questions sheet it waits for the sheet's own Back on the web. */
  readonly openQuestion: (discussionId: string) => void;
}

/**
 * What the quiet room (R3 F) needs on a member's screen: whether its two sheets are open, the replay they play, the host's offer and
 * the way into a question. The offer is worked out here from what the server read (`quietOffer`), so a room with nothing to replay,
 * or one people are talking in, makes none.
 */
export function useQuietRoom(scope: AccountScope, view: Member): QuietRoom {
  const roomId = view.room.roomId;
  const router = useRouter();
  const now = useNow(60_000);
  const [replaying, setReplaying] = useState(false);
  const [questioning, setQuestioning] = useState(false);
  const [, setPutAwayCount] = useState(0);
  const replay = useRoomReplay(scope, roomId, replaying);
  const putAway =
    view.replay !== undefined && scope.storage.get(offerKey(roomId, view.replay.day)) !== undefined
      ? new Set([view.replay.day])
      : new Set<string>();
  return {
    offer: quietOffer({ replay: view.replay, lastMessageAt: view.lastMessageAt, now, dismissed: putAway }),
    putOfferAway(day) {
      scope.storage.set(offerKey(roomId, day), '1');
      setPutAwayCount((count) => count + 1);
    },
    replay: { open: replaying, setOpen: setReplaying, ...replay },
    questions: { open: questioning, setOpen: setQuestioning },
    openQuestion(discussionId) {
      const open = () => router.push(discussionHref(roomId, discussionId));
      // From the questions sheet the sheet closes first and the screen opens after its own Back (D-238); from the card there is no sheet.
      if (questioning) closeThen(() => setQuestioning(false), open);
      else open();
    },
  };
}

import { CHAT_MIN_WIDTH, conversationHasRail, threadHasList } from './talk-columns';

describe('which side columns a desktop window has room for', () => {
  it('gives a thread Talk’s list only from 1280 px, so the chat is not squeezed beside the series panel', () => {
    expect(threadHasList(1024)).toBe(false);
    expect(threadHasList(1100)).toBe(false);
    expect(threadHasList(1279)).toBe(false);
    expect(threadHasList(1280)).toBe(true);
    expect(threadHasList(1440)).toBe(true);
  });

  it('gives a conversation the "In this chat" rail only while its chat keeps room', () => {
    expect(conversationHasRail(1024)).toBe(false);
    expect(conversationHasRail(1100)).toBe(false);
    expect(conversationHasRail(1280)).toBe(true);
    expect(conversationHasRail(1440)).toBe(true);
    expect(CHAT_MIN_WIDTH).toBe(400);
  });
});

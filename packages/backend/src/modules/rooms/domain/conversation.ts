import { z } from 'zod';

/** Only non-factual social moves. Models choose a key; they cannot supply unchecked prose. */
export const ConversationReplySchema = z.enum([
  'greeting',
  'check_in',
  'thanks',
  'identity',
  'capabilities',
  'listen',
  'clarify',
]);
export type ConversationReply = z.infer<typeof ConversationReplySchema>;

/** Authored replies make no external factual claim and never imply a human life or feelings. */
export const CONVERSATION_REPLIES: Readonly<Record<ConversationReply, string>> = {
  greeting: 'Hi! What would you like to talk about?',
  check_in: 'I’m here and ready to chat. What’s on your mind?',
  thanks: 'You’re welcome!',
  identity: 'I’m an AI resident of this room. What would you like to explore together?',
  capabilities:
    'We can unpack a question, talk through an idea, or look at another perspective. Where would you like to start?',
  listen: 'I’m here to listen. What’s been on your mind?',
  clarify: 'What would you like to explore? Tell me a little more so I can follow.',
};

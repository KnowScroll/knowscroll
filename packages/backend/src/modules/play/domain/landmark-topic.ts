/** A topic a Scroll revision is attributed to, as the catalogue records it. */
export interface AttributedTopic {
  readonly topicId: string;
  readonly role: 'primary' | 'supporting' | 'incidental';
  readonly weight: number;
}

/**
 * The topic a landmark belongs to: the Scroll's primary topic, or failing that its heaviest one. A
 * Scroll's topic is public catalogue data, so the choice says nothing about the person. `undefined`
 * when the Scroll carries none, and then the landmark waits in the tray (D-084).
 */
export function landmarkTopicOf(topics: readonly AttributedTopic[]): string | undefined {
  const primary = topics.find((topic) => topic.role === 'primary');
  if (primary) return primary.topicId;
  return [...topics].sort((a, b) => b.weight - a.weight || a.topicId.localeCompare(b.topicId))[0]?.topicId;
}

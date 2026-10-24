/**
 * "Not interested" keeps one asset out of one person's offers for a while (D-055). It is a routing
 * constraint about what they want to see now, so it lapses by itself: nothing derives a taste, a
 * planet or a label from it.
 */

/** How long a "Not interested" keeps its asset out of the person's offers. */
export const NOT_INTERESTED_DAYS = 14;

/** The most assets one person holds as "Not interested" at once; the oldest lapse first. */
export const NOT_INTERESTED_LIMIT = 500;

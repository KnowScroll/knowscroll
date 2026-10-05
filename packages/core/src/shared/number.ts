/** Rounds to four decimal places, the precision recorded scores and weights are kept at. */
export const round = (n: number) => Math.round(n * 10_000) / 10_000;

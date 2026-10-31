import type { ThreadCall } from '@knowscroll/contracts';

/** The letter a call's option wears: A, B or C. */
export const optionLetter = (option: number): string => String.fromCharCode(65 + option);

/** "Before Part 2": which part the call comes before. */
export const callPartLabel = (call: Pick<ThreadCall, 'part'>): string => `Before Part ${String(call.part)}`;

/**
 * The line under a call, in words (T3 "2 of 4 have called · answers stay hidden until you call"). It counts people who
 * called and says what the person is waiting for, never who is slow and never who picked what before the reveal.
 */
export function callSummaryWords(call: ThreadCall): string {
  const counted =
    call.called === 0 ? 'Nobody has called yet' : `${String(call.called)} of ${String(call.of)} have called`;
  switch (call.stage) {
    case 'open':
      return `${counted} · answers stay hidden until you call`;
    case 'locked':
      return `${counted} · answers show once everyone who shares where they are has finished Part ${String(call.part)}, or after two days`;
    case 'closed':
      return call.reason === 'revealed'
        ? `${counted} · revealed without you`
        : `${counted} · you started this part, so it is not a guess now`;
    case 'revealed':
      return `${counted} · revealed together`;
  }
}

/**
 * The chip on a part's row in the Series sheet (T3 "Call it · 2 of 4 in"). Only a call the person can still act on or
 * is waiting on has one: a closed call has nothing to offer, and a revealed one says so.
 */
export function callChipWords(call: ThreadCall): string | undefined {
  switch (call.stage) {
    case 'open':
      return `Call it first · ${String(call.called)} of ${String(call.of)} in`;
    case 'locked':
      return 'Called · waiting for the party';
    case 'revealed':
      return 'Revealed';
    case 'closed':
      return undefined;
  }
}

/**
 * What the reveal says of the person's own call and of the party: "Called it!" or "Plot twist!", and how many called
 * it right ("+1 for 3 of you"). A wrong call is a twist, never a loss: it shows no minus and no count of misses.
 */
export function revealWords(call: Extract<ThreadCall, { stage: 'revealed' }>): {
  title: string;
  spark: string | undefined;
} {
  if (!call.right) return { title: 'Plot twist!', spark: undefined };
  return {
    title: 'Called it!',
    spark: call.rightCount > 1 ? `+1 for ${String(call.rightCount)} of you` : '+1 spark',
  };
}

/** A call as this device remembers having opened it: the part and the exact revision, never a pick. */
export const callKey = (call: Pick<ThreadCall, 'part' | 'assetId' | 'assetRevision'>): string =>
  `${String(call.part)}@${call.assetId}@${String(call.assetRevision)}`;

/**
 * The call the bar above the composer offers: the first one the person can still make, else the first they are waiting
 * on, else the first reveal they have not opened on this device. Nothing once every call is closed or its reveal was
 * seen, so the bar never nags. `seen` is this device's own memory and is never sent.
 */
export function callForBar(calls: readonly ThreadCall[], seen: ReadonlySet<string>): ThreadCall | undefined {
  return (
    calls.find((call) => call.stage === 'open') ??
    calls.find((call) => call.stage === 'locked') ??
    calls.find((call) => call.stage === 'revealed' && !seen.has(callKey(call)))
  );
}

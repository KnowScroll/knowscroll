export type GestureOwner = 'undecided' | 'child' | 'platform_back' | 'reading' | 'horizontal' | 'vertical';
/** One gesture is one intent, locked until release. Reading momentum never navigates. */
export function createGestureArbitrator(input: {
  startX: number;
  scroll: boolean;
  childOwns: boolean;
  native: boolean;
}) {
  let owner: GestureOwner = input.childOwns
    ? 'child'
    : input.native && input.startX < 24
      ? 'platform_back'
      : 'undecided';
  let dx = 0;
  let dy = 0;
  return {
    move(x: number, y: number) {
      dx = x;
      dy = y;
      if (owner === 'undecided' && Math.max(Math.abs(x), Math.abs(y)) >= 12)
        owner = Math.abs(x) > Math.abs(y) * 1.2 ? 'horizontal' : input.scroll ? 'reading' : 'vertical';
      return owner;
    },
    release(): 'next' | 'previous' | 'subject' | undefined {
      if (owner === 'horizontal' && Math.abs(dx) >= 64) return dx < 0 ? 'next' : 'previous';
      if (owner === 'vertical' && dy <= -64) return 'subject';
      return undefined;
    },
    cancel() {
      owner = 'child';
    },
  };
}

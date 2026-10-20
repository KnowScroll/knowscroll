/** The token in a sign-in link (`…/redeem#token=ksl_…`, or `?token=` from a pasted or app link). */
export function tokenFromLink(link: string): string | undefined {
  const match = /[#?&]token=(ksl_[A-Za-z0-9_-]{43})(?:$|[&#])/.exec(link.trim());
  return match?.[1];
}

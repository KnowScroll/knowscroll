import type { z } from 'zod';
import type { ShareableContentProjectionSchema } from '@knowscroll/contracts';

type Content = z.infer<typeof ShareableContentProjectionSchema>;

/** What a share link opens to, once the server has decided access. */
export type LandingState =
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'public'; readonly content: Content }
  | { readonly kind: 'conversation'; readonly content: Content; readonly conversationId: string }
  | { readonly kind: 'try_again' };

export interface LandingOptions {
  readonly signedIn: boolean;
}

const escapeMap: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};
const escape = (text: string) => text.replace(/[&<>"']/g, (character) => escapeMap[character] ?? character);

// Values of the content register in packages/design-tokens (paper, ink, ink2, accent, onAccent,
// rule, paper2, corrected). The API does not depend on the client's token package.
const styles = `
:root{--paper:#FFFBF0;--paper2:#F4EDD8;--ink:#111111;--ink2:#4A463D;--accent:#2C46E8;--on-accent:#FFFBF0;--rule:#D9D1BC;--corrected-bg:#FFE9DE;--corrected-fg:#8A2C07}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:34rem;margin:0 auto;padding:1rem 1rem 3rem}
.bar{display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--rule);padding:.5rem 0 .75rem;margin-bottom:2rem}
.brand{font-weight:700;letter-spacing:-.01em}
a{color:var(--accent)}
h1{font-size:1.65rem;line-height:1.2;letter-spacing:-.02em;margin:.25rem 0 .75rem}
.kicker{margin:0;color:var(--ink2);font-size:.9rem}
.summary{color:var(--ink2);margin:0 0 1.5rem}
.label{display:inline-block;background:var(--corrected-bg);color:var(--corrected-fg);border:2px solid var(--corrected-fg);border-radius:.5rem;padding:.1rem .5rem;font-size:.85rem;font-weight:600;margin:0 0 .75rem}
.actions{display:flex;flex-wrap:wrap;gap:.75rem;align-items:center}
.button{display:inline-flex;align-items:center;min-height:48px;padding:0 1.25rem;border:2px solid var(--ink);border-radius:.75rem;font-weight:600;text-decoration:none;background:var(--paper);color:var(--ink)}
.button.primary{background:var(--accent);color:var(--on-accent)}
.button:focus-visible,a:focus-visible{outline:3px solid var(--ink);outline-offset:3px}
.note{color:var(--ink2);margin:1.5rem 0 0}
`;

const kindWord = (content: Content) => {
  const metadata = content.status === 'available' ? content.metadata : content.current.metadata;
  return metadata.kind === 'reel' ? 'Reel' : 'Scroll';
};
const contentPath = (content: Content) => {
  const metadata = content.status === 'available' ? content.metadata : content.current.metadata;
  return `/${metadata.kind}/${content.target.assetId}`;
};

function page(options: { title: string; meta?: string; body: string; signedIn: boolean }): string {
  const signIn = options.signedIn ? '' : '<a href="/welcome">Sign in</a>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="robots" content="noindex, nofollow">
<title>${escape(options.title)}</title>
${options.meta ?? ''}<style>${styles}</style>
</head>
<body>
<main>
<header class="bar"><span class="brand">KnowScroll</span>${signIn}</header>
${options.body}
</main>
</body>
</html>
`;
}

function contentBody(content: Content, extra: { kicker?: string; actions: string; note?: string }): string {
  const current = content.status === 'available' ? content.metadata : content.current.metadata;
  const word = kindWord(content);
  const corrected =
    content.status === 'corrected'
      ? `<p class="label">Updated</p>\n<p class="kicker">This ${word} was updated after it was shared.</p>\n`
      : '';
  const kicker = extra.kicker ?? (content.status === 'available' ? word : '');
  return `<section lang="${escape(current.language)}">
${corrected}${kicker ? `<p class="kicker">${escape(kicker)}</p>\n` : ''}<h1>${escape(current.title)}</h1>
<p class="summary">${escape(current.summary)}</p>
</section>
<div class="actions">${extra.actions}</div>${extra.note ? `\n<p class="note">${extra.note}</p>` : ''}`;
}

/**
 * The share landing as a small server-rendered page: it works without scripts and without the
 * app, and never contains a person's name. Only public metadata appears; an unavailable link
 * shows no title or poster and says nothing about why (stopped, expired, withdrawn or private).
 * Titles and summaries are escaped text.
 */
export function renderLanding(state: LandingState, options: LandingOptions): string {
  if (state.kind === 'try_again')
    return page({
      title: 'KnowScroll',
      signedIn: options.signedIn,
      body: `<h1>We couldn’t open this link right now</h1>
<p class="summary">Try again in a moment.</p>
<div class="actions"><a class="button" href="">Try again</a></div>`,
    });
  if (state.kind === 'unavailable')
    return page({
      title: 'KnowScroll',
      signedIn: options.signedIn,
      body: `<h1>This link is no longer available</h1>
<p class="summary">It was stopped, it has expired, or it is not available to you.</p>
<div class="actions"><a class="button primary" href="/">Go to KnowScroll</a></div>${
        options.signedIn
          ? ''
          : '\n<p class="note">If it was shared with you privately, <a href="/welcome">sign in</a> to see it.</p>'
      }`,
    });
  const word = kindWord(state.content);
  const open =
    state.content.status === 'corrected' ? `${word === 'Reel' ? 'Watch' : 'Read'} the revised ${word}` : `Open ${word}`;
  const primary = `<a class="button primary" href="${contentPath(state.content)}">${open}</a>`;
  if (state.kind === 'conversation')
    return page({
      title: 'KnowScroll',
      signedIn: options.signedIn,
      body: contentBody(state.content, {
        kicker: 'Shared in your conversation',
        actions: `${primary}<a class="button" href="/conversations/${escape(state.conversationId)}">Reply in Talk</a>`,
      }),
    });
  const current = state.content.status === 'available' ? state.content.metadata : state.content.current.metadata;
  const meta = [
    `<meta property="og:site_name" content="KnowScroll">`,
    `<meta property="og:type" content="website">`,
    `<meta property="og:title" content="${escape(current.title)}">`,
    `<meta property="og:description" content="${escape(current.summary.slice(0, 200))}">`,
  ].join('\n');
  return page({
    title: `${current.title} · KnowScroll`,
    meta: `${meta}\n`,
    signedIn: options.signedIn,
    body: contentBody(state.content, {
      actions: options.signedIn ? primary : `${primary}<a class="button" href="/welcome">Sign in to keep it</a>`,
    }),
  });
}

import { describe, expect, it } from 'vitest';
import { renderLanding, type LandingState } from './share-landing-page.js';

const assetId = '0199a000-0000-7000-8000-000000000001';
const target = { assetId, assetRevision: 1 };
const metadata = {
  kind: 'reel' as const,
  title: 'What one answer costs to serve',
  summary: 'Tokens, memory, time.',
  language: 'en',
};

const available: LandingState = { kind: 'public', content: { status: 'available', target, metadata } };
const corrected: LandingState = {
  kind: 'public',
  content: {
    status: 'corrected',
    target,
    current: {
      assetId,
      assetRevision: 2,
      metadata: { ...metadata, kind: 'scroll', title: 'Why long prompts cost more' },
    },
  },
};

describe('share landing page', () => {
  it('shows a signed-out visitor the card, a way in and a way to sign in', () => {
    const html = renderLanding(available, { signedIn: false });
    expect(html).toContain('<h1>What one answer costs to serve</h1>');
    expect(html).toContain('Tokens, memory, time.');
    expect(html).toContain(`href="/reel/${assetId}"`);
    expect(html).toContain('Open Reel');
    expect(html).toContain('Sign in to keep it');
    expect(html).toContain('property="og:title" content="What one answer costs to serve"');
    expect(html).toContain('<title>What one answer costs to serve · KnowScroll</title>');
  });

  it('leaves out the sign-in prompts for a signed-in person', () => {
    const html = renderLanding(available, { signedIn: true });
    expect(html).not.toContain('Sign in');
    expect(html).toContain('Open Reel');
  });

  it('says the link was updated and opens the current revision with the right verb', () => {
    const html = renderLanding(corrected, { signedIn: false });
    expect(html).toContain('Updated');
    expect(html).toContain('This Scroll was updated after it was shared.');
    expect(html).toContain('<h1>Why long prompts cost more</h1>');
    expect(html).toContain('Read the revised Scroll');
    expect(html).toContain(`href="/scroll/${assetId}"`);
  });

  it('offers a member their conversation, without the sign-in prompts, and no public preview tags', () => {
    const html = renderLanding(
      { kind: 'conversation', content: { status: 'available', target, metadata }, conversationId: assetId },
      { signedIn: true },
    );
    expect(html).toContain('Shared in your conversation');
    expect(html).toContain(`href="/conversations/${assetId}"`);
    expect(html).toContain('Reply in Talk');
    expect(html).not.toContain('og:title');
    expect(html).toContain('<title>KnowScroll</title>');
  });

  it('shows no title, summary or reason for an unavailable link, and a private-link hint only to visitors', () => {
    const visitor = renderLanding({ kind: 'unavailable' }, { signedIn: false });
    expect(visitor).toContain('This link is no longer available');
    expect(visitor).toContain('If it was shared with you privately, <a href="/welcome">sign in</a>');
    expect(visitor).not.toContain('og:');
    const member = renderLanding({ kind: 'unavailable' }, { signedIn: true });
    expect(member).toContain('This link is no longer available');
    expect(member).not.toContain('sign in');
  });

  it('asks to try again, rather than claiming a link is gone, when the server could not decide', () => {
    const html = renderLanding({ kind: 'try_again' }, { signedIn: false });
    expect(html).toContain('We couldn’t open this link right now');
    expect(html).not.toContain('no longer available');
  });

  it('escapes every piece of content text', () => {
    const hostile: LandingState = {
      kind: 'public',
      content: {
        status: 'available',
        target,
        metadata: {
          ...metadata,
          title: '<img src=x onerror=alert(1)>',
          summary: '" onmouseover="x',
          language: 'en"><b>',
        },
      },
    };
    const html = renderLanding(hostile, { signedIn: false });
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<b>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('&quot; onmouseover=&quot;x');
  });
});

import { describe, expect, it } from 'vitest';
import {
  extractResearch,
  extractResearchLinks,
  fetchResearchPage,
  fetchResearchWithLinks,
  MAX_RESEARCH_LINKS,
  MAX_RESEARCH_BYTES,
  publicAddress,
  researchUrl,
  type ResearchNetwork,
} from './public-pages.js';
const paragraph =
  'This is a public research paragraph containing a substantial factual explanation with enough original words to form a stable passage for the private evidence package.';
const html = `<html><title>Public research</title><main>${Array.from({ length: 5 }, (_, n) => `<p>${paragraph} Example ${n}.</p>`).join('')}</main></html>`;
const page = 'https://science.nasa.gov/earth/earth-facts/';
const net = (overrides: Partial<ResearchNetwork> = {}): ResearchNetwork => ({
  addresses: () => Promise.resolve([{ address: '8.8.8.8', family: 4 }]),
  read: () => Promise.resolve({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: html }),
  ...overrides,
});
describe('public research boundary (CI fixture)', () => {
  it.each([
    ['http://science.nasa.gov/earth/', 'scheme_refused'],
    ['https://example.com/', 'host_refused'],
    ['https://science.nasa.gov:8443/', 'port_refused'],
    ['https://user:password@science.nasa.gov/', 'credentials_refused'],
    ['https://openstax.org/books/', 'openstax_refused'],
    ['https://arxiv.org/pdf/1234.12345', 'path_refused'],
    ['https://science.nasa.gov/?token=credential', 'url_parameters_refused'],
  ])('refuses %s before networking', (url, code) => expect(() => researchUrl(url)).toThrow(code));
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '172.16.1.1',
    '192.168.1.1',
    '192.0.2.0',
    '192.0.2.1',
    '192.0.2.255',
    '100.64.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
  ])('refuses nonpublic address %s', (ip) => expect(publicAddress(ip)).toBe(false));
  it.each(['192.0.66.108', '192.2.0.1', '192.2.255.255'])(
    'permits public addresses outside reserved192.0 ranges %s',
    (ip) => expect(publicAddress(ip)).toBe(true),
  );
  it('refuses a mixed public/private DNS answer', async () => {
    await expect(
      fetchResearchPage(
        page,
        net({
          addresses: () =>
            Promise.resolve([
              { address: '8.8.8.8', family: 4 },
              { address: '127.0.0.1', family: 4 },
            ]),
        }),
      ),
    ).rejects.toThrow('address_refused');
  });
  it('checks redirect host and addresses again', async () => {
    await expect(
      fetchResearchPage(
        page,
        net({ read: () => Promise.resolve({ status: 302, headers: { location: 'https://example.com/' }, body: '' }) }),
      ),
    ).rejects.toThrow('host_refused');
    let count = 0;
    await expect(
      fetchResearchPage(
        page,
        net({
          addresses: () => Promise.resolve([{ address: ++count === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }]),
          read: () => Promise.resolve({ status: 302, headers: { location: '/next' }, body: '' }),
        }),
      ),
    ).rejects.toThrow('address_refused');
  });
  it('bounds redirects, size, compression and content type', async () => {
    await expect(
      fetchResearchPage(
        page,
        net({ read: () => Promise.resolve({ status: 302, headers: { location: '/next' }, body: '' }) }),
      ),
    ).rejects.toThrow('redirect_limit');
    await expect(
      fetchResearchPage(
        page,
        net({
          read: () =>
            Promise.resolve({
              status: 200,
              headers: { 'content-type': 'text/html' },
              body: 'a'.repeat(MAX_RESEARCH_BYTES + 1),
            }),
        }),
      ),
    ).rejects.toThrow('page_too_large');
    await expect(
      fetchResearchPage(
        page,
        net({
          read: () => Promise.resolve({ status: 200, headers: { 'content-type': 'application/pdf' }, body: html }),
        }),
      ),
    ).rejects.toThrow('content_type_refused');
    await expect(
      fetchResearchPage(
        page,
        net({
          read: () =>
            Promise.resolve({
              status: 200,
              headers: { 'content-type': 'text/html', 'content-encoding': 'gzip' },
              body: html,
            }),
        }),
      ),
    ).rejects.toThrow('encoding_refused');
  });
  it('refuses soft 404 and extracts stable original passage identities without executable text', async () => {
    expect(() =>
      extractResearch(html.replace('Public research', 'Page not found'), page, '2026-10-20T00:00:00.000Z'),
    ).toThrow('soft_404');
    const a = await fetchResearchPage(page, net(), () => new Date('2026-10-20T00:00:00.000Z'));
    const b = extractResearch(
      html.replace('<main>', '<script>secret function</script><main>'),
      page,
      '2026-10-21T00:00:00.000Z',
    );
    expect(a.sha256).toBe(b.sha256);
    expect(a.passages).toEqual(b.passages);
    expect(a.passages[0]?.text).toContain(paragraph);
  });
  it('drops footnote markers, typeset maths and reference lists, and keeps an arXiv-style abstract', () => {
    const cited = `${paragraph}<sup id="cite_ref-1" class="reference"><a href="#cite_note-1">[1]</a></sup>`;
    const withMaths = `${paragraph} where <span class="mwe-math-element"><math><mi>x</mi><annotation>{\\displaystyle x}</annotation></math></span> varies.`;
    const references =
      '<ol class="references"><li id="cite_note-1">A cited work, a title and a journal reference, 2020.</li></ol>';
    const abstract = `<blockquote class="abstract mathjax"><span class="descriptor">Abstract:</span> ${paragraph}</blockquote>`;
    const extracted = extractResearch(
      `<html><title>Public research</title><main><p>${cited}</p><p>${withMaths}</p>${references}${abstract}</main></html>`,
      page,
      '2026-10-20T00:00:00.000Z',
    );
    const text = extracted.passages.map((passage) => passage.text).join('\n');
    expect(text).not.toMatch(/\[1\]|displaystyle|cited work/u);
    expect(extracted.passages[0]?.text.endsWith('private evidence package.')).toBe(true);
    expect(extracted.passages.at(-1)?.text.startsWith('Abstract:')).toBe(true);
  });
});

describe('the links of a research page (topic growth, CI fixture)', () => {
  const wiki = 'https://en.wikipedia.org/wiki/Tide';
  const prose = (links: string) => `<p>${paragraph} ${links}</p>`;
  const wikiPage = (body: string, extra = '') =>
    `<html><title>Tide - Wikipedia</title>${extra}<main>${body}</main></html>`;

  it('reads the links of the prose, in order, as absolute addresses without fragments, and each once', () => {
    const links = extractResearchLinks(
      wikiPage(
        prose(
          '<a href="/wiki/Tidal_force#Origin">tidal force</a> and <a href="https://en.wikipedia.org/wiki/Spring_tide">spring tides</a> and <a href="/wiki/Tidal_force">again</a> <a href="/wiki/Moon/">trailing slash</a>',
        ),
      ),
      wiki,
    );
    expect(links).toEqual([
      'https://en.wikipedia.org/wiki/Tidal_force',
      'https://en.wikipedia.org/wiki/Spring_tide',
      'https://en.wikipedia.org/wiki/Moon',
    ]);
  });

  it('keeps only links to a reviewed host, an article and not the page itself', () => {
    const links = extractResearchLinks(
      wikiPage(
        prose(
          [
            '<a href="/wiki/Category:Tides">a category</a>',
            '<a href="/wiki/File:Tide.png">a file</a>',
            '<a href="/wiki/Special:Random">special</a>',
            '<a href="/wiki/Main_Page">main</a>',
            '<a href="/w/index.php?title=Tidal_flat&action=edit&redlink=1">a red link</a>',
            '<a href="/wiki/Tide?action=raw">a query</a>',
            '<a href="https://example.com/wiki/Tide">an unreviewed host</a>',
            '<a href="http://en.wikipedia.org/wiki/Neap_tide">http</a>',
            '<a href="https://user:pw@en.wikipedia.org/wiki/Neap_tide">credentials</a>',
            '<a href="https://en.wikipedia.org:8443/wiki/Neap_tide">a port</a>',
            '<a href="#cite_note-1">an anchor</a>',
            '<a href="javascript:alert(1)">script</a>',
            '<a href="/wiki/Tide">itself</a>',
            '<a href="/wiki/Tide#Causes">itself with a fragment</a>',
            '<a href="https://science.nasa.gov/earth/oceans/">a reviewed other host</a>',
            '<a href="https://science.nasa.gov/">a root page</a>',
            '<a href="https://arxiv.org/pdf/1234.12345">an arXiv pdf</a>',
            '<a href="https://arxiv.org/abs/1234.12345">an arXiv abstract</a>',
            '<a href="/wiki/Neap_tide">a real one</a>',
          ].join(' '),
        ),
      ),
      wiki,
    );
    expect(links).toEqual([
      'https://science.nasa.gov/earth/oceans',
      'https://arxiv.org/abs/1234.12345',
      'https://en.wikipedia.org/wiki/Neap_tide',
    ]);
  });

  it('does not read the navigation, a footer, a reference list, a footnote marker or a link outside a paragraph', () => {
    const links = extractResearchLinks(
      `<html><title>Tide - Wikipedia</title><nav><p><a href="/wiki/Navigation_page">nav</a></p></nav>
        <main>
          ${prose('<sup class="reference"><a href="/wiki/Footnote_page">[1]</a></sup>')}
          <ul><li><a href="/wiki/List_item_page">a list item</a></li></ul>
          <table class="navbox"><tr><td><a href="/wiki/Navbox_page">navbox</a></td></tr></table>
          <ol class="references"><li><p><a href="/wiki/Reference_page">ref</a></p></li></ol>
          ${prose('<a href="/wiki/Prose_page">prose</a>')}
        </main><footer><p><a href="/wiki/Footer_page">footer</a></p></footer></html>`,
      wiki,
    );
    expect(links).toEqual(['https://en.wikipedia.org/wiki/Prose_page']);
  });

  it('handles single quotes, entities in addresses and attributes in any order, and skips a broken address', () => {
    const links = extractResearchLinks(
      wikiPage(
        prose(
          `<a title="x" class="y" href='/wiki/Tidal_locking'>a</a> <a href="/wiki/Rock_%26_roll">b</a> <a href="https://[bad">c</a> <a>no href</a>`,
        ),
      ),
      wiki,
    );
    expect(links).toEqual([
      'https://en.wikipedia.org/wiki/Tidal_locking',
      'https://en.wikipedia.org/wiki/Rock_%26_roll',
    ]);
  });

  it('gives at most the bound, however many a page has', () => {
    const many = Array.from({ length: MAX_RESEARCH_LINKS + 40 }, (_, n) => `<a href="/wiki/Page_${String(n)}">p</a>`);
    const links = extractResearchLinks(wikiPage(prose(many.join(' '))), wiki);
    expect(links).toHaveLength(MAX_RESEARCH_LINKS);
    expect(links[0]).toBe('https://en.wikipedia.org/wiki/Page_0');
  });

  it('is read with the page by the fetch, through the same URL rule, DNS and size checks, and the passages are the page’s own', async () => {
    const withLinks = wikiPage(
      [prose('<a href="/wiki/Neap_tide">neap</a>'), prose('Another fact.'), prose('And a third.')].join(''),
    );
    const network = net({
      read: () =>
        Promise.resolve({ status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: withLinks }),
    });
    const both = await fetchResearchWithLinks(wiki, network, () => new Date('2026-10-20T00:00:00.000Z'));
    expect(both.links).toEqual(['https://en.wikipedia.org/wiki/Neap_tide']);
    const alone = await fetchResearchPage(wiki, network, () => new Date('2026-10-20T00:00:00.000Z'));
    expect(both.page).toEqual(alone);
    await expect(fetchResearchWithLinks('https://example.com/', net())).rejects.toThrow('host_refused');
    await expect(
      fetchResearchWithLinks(wiki, net({ addresses: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]) })),
    ).rejects.toThrow('address_refused');
  });
});

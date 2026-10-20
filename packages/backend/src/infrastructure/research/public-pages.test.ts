import { describe, expect, it } from 'vitest';
import {
  extractResearch,
  fetchResearchPage,
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
    '100.64.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
  ])('refuses nonpublic address %s', (ip) => expect(publicAddress(ip)).toBe(false));
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
});

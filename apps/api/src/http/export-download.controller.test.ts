import 'reflect-metadata';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import type { ConsumeDataExportLink } from '@knowscroll/backend/modules/identity';
import { createAuthLimiters } from './auth-rate-limit.js';
import { ExportDownloadController } from './export-download.controller.js';

const token = `kse_${'A'.repeat(43)}`;

function fakeResponse() {
  const headers = new Map<string, string>();
  const response = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader(name: string, value: string | number) {
      headers.set(name.toLowerCase(), String(value));
      return response;
    },
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    end(body?: unknown) {
      response.body = body;
      return response;
    },
  };
  return { response, headers };
}

function controller(consume: ConsumeDataExportLink) {
  return new ExportDownloadController(createAuthLimiters(), consume);
}

const requestOf = (method: string) =>
  ({ method, headers: {}, socket: { remoteAddress: '203.0.113.7' } }) as unknown as Request;

describe('GET /auth/exports/{token}', () => {
  it.each(['HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'])(
    'answers 405 to %s and never touches the file, so a link prefetcher cannot spend the one download',
    async (method) => {
      const consume = vi.fn<ConsumeDataExportLink>();
      const { response, headers } = fakeResponse();
      await controller(consume).download(token, requestOf(method), response as unknown as Response);
      expect(consume).not.toHaveBeenCalled();
      expect(response.statusCode).toBe(405);
      expect(headers.get('allow')).toBe('GET');
      expect(headers.get('cache-control')).toBe('private, no-store');
      expect(JSON.parse(String(response.body))).toMatchObject({ code: 'METHOD_NOT_ALLOWED', status: 405 });
    },
  );

  it('does not spend the client budget on a refused method', async () => {
    const limits = createAuthLimiters();
    const use = new ExportDownloadController(limits, () => Promise.resolve({ kind: 'gone' }));
    for (let n = 0; n < 200; n += 1)
      await use.download(token, requestOf('HEAD'), fakeResponse().response as unknown as Response);
    const { response } = fakeResponse();
    await use.download(token, requestOf('GET'), response as unknown as Response);
    expect(response.statusCode).toBe(404);
  });

  it('hands the file over to GET, once per link', async () => {
    const bytes = new TextEncoder().encode('{"version":"knowscroll-export.v1"}');
    const consume = vi
      .fn<ConsumeDataExportLink>()
      .mockResolvedValueOnce({ kind: 'file', bytes })
      .mockResolvedValue({ kind: 'gone' });
    const use = controller(consume);
    const first = fakeResponse();
    await use.download(token, requestOf('GET'), first.response as unknown as Response);
    expect(first.response.statusCode).toBe(200);
    expect(first.headers.get('content-disposition')).toBe('attachment; filename="knowscroll-export.json"');
    expect(Buffer.from(first.response.body as Buffer).toString()).toBe('{"version":"knowscroll-export.v1"}');
    const second = fakeResponse();
    await use.download(token, requestOf('GET'), second.response as unknown as Response);
    expect(second.response.statusCode).toBe(404);
    expect(consume).toHaveBeenCalledTimes(2);
  });
});

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { runMarkedTransaction } from '../../../infrastructure/postgres/transaction-marker.js';
import { agentMailSender } from './agentmail-sender.js';

/**
 * The AgentMail adapter against a local fake AgentMail (CI fixture; no request leaves the
 * machine). Every key, inbox, address and link here is a fixture.
 */
interface Received {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly body: string;
}

const fixtureKey = 'fixture-agentmail-key-canary-Zq7';
const mail = { to: 'asha@example.test', link: 'https://app.ci.invalid/redeem#token=ksl_fixture' };

describe('agentMailSender (fake AgentMail on loopback)', () => {
  let server: Server;
  let baseUrl: string;
  let received: Received[];
  let respond: (request: IncomingMessage, response: ServerResponse) => void;

  beforeAll(async () => {
    server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')));
      request.on('end', () => {
        received.push({
          method: request.method ?? '',
          url: request.url ?? '',
          authorization: request.headers.authorization,
          contentType: request.headers['content-type'],
          body,
        });
        respond(request, response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    received = [];
    respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message_id: '<fixture@agentmail>', thread_id: 'fixture-thread' }));
    };
  });

  const sender = (timeoutMs = 2_000) =>
    agentMailSender({ apiKey: fixtureKey, inboxId: 'knowscroll@agentmail.to', baseUrl: `${baseUrl}/`, timeoutMs });

  it('sends exactly one POST to the inbox send route with the key only in the Authorization header', async () => {
    expect(await sender()(mail)).toEqual({ kind: 'sent' });
    expect(received).toHaveLength(1);
    const [request] = received;
    expect(request).toMatchObject({
      method: 'POST',
      url: '/v0/inboxes/knowscroll%40agentmail.to/messages/send',
      authorization: `Bearer ${fixtureKey}`,
      contentType: 'application/json',
    });
    const body = JSON.parse(request?.body ?? '{}') as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['html', 'subject', 'text', 'to']);
    expect(body['to']).toBe(mail.to);
    expect(body['text']).toContain(mail.link);
    expect(request?.body).not.toContain(fixtureKey);
  });

  it('counts a 2xx only when its body carries a message_id', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ thread_id: 'no-message-id' }));
    };
    expect(await sender()(mail)).toEqual({ kind: 'failed', reason: 'malformed_response', status: 200 });
    respond = (_request, response) => {
      response.writeHead(202);
      response.end('not json');
    };
    expect(await sender()(mail)).toEqual({ kind: 'failed', reason: 'malformed_response', status: 202 });
  });

  it('never retries a failure', async () => {
    respond = (_request, response) => {
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message_id: 'even-with-an-id' }));
    };
    expect(await sender()(mail)).toEqual({ kind: 'failed', reason: 'http_error', status: 503 });
    expect(received).toHaveLength(1);
  });

  it('never follows a redirect', async () => {
    respond = (request, response) => {
      if (request.url === '/elsewhere') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message_id: 'followed' }));
        return;
      }
      response.writeHead(307, { location: `${baseUrl}/elsewhere` });
      response.end();
    };
    expect(await sender()(mail)).toEqual({ kind: 'failed', reason: 'http_error', status: 307 });
    expect(received.map((request) => request.url)).toEqual(['/v0/inboxes/knowscroll%40agentmail.to/messages/send']);
  });

  it('reads at most 64 KiB of a response', async () => {
    respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ message_id: 'x', padding: 'p'.repeat(70 * 1024) }));
    };
    expect(await sender()(mail)).toEqual({ kind: 'failed', reason: 'malformed_response', status: 200 });
  });

  it('times out a provider that never answers, once', async () => {
    respond = () => undefined;
    expect(await sender(200)(mail)).toEqual({ kind: 'failed', reason: 'timeout' });
    expect(received).toHaveLength(1);
  });

  it('refuses to run inside a database transaction', async () => {
    const result = await runMarkedTransaction('fixture', () => sender()(mail));
    expect(result).toEqual({ kind: 'failed', reason: 'refused_in_transaction' });
    expect(received).toHaveLength(0);
  });
});

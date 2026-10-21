import 'reflect-metadata';
import { call } from '@orpc/server';
import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import {
  SceneChunkSchema,
  type SceneClientCapabilities,
  type SceneManifestRead,
  type SceneChunkRead,
} from '@knowscroll/contracts';
import type { ReadOwnSceneManifest, ReadOwnSceneChunk } from '@knowscroll/backend/modules/scenes';
import type { Caller } from './callers.js';
import { scopeGuard } from './scope-guard.js';
import { ScenesController } from './scenes.controller.js';
const uuid = '0199a000-0000-7000-8000-000000000001',
  accountId = '0199a000-0000-7000-8000-000000000002',
  chunkId = '0199a000-0000-7000-8000-000000000003';
const caller: Caller = { accountId, universeId: uuid, privacyEpoch: 2, sessionId: uuid, credential: 'cookie' };
const authority = { universeId: uuid, privacyEpoch: 2, actor: { kind: 'account', accountId } };
const capabilities: SceneClientCapabilities = {
  version: 'scene-client.v1',
  descriptors: ['scene-descriptor.v1'],
  chunks: ['scene-chunk.v1'],
  manifests: ['scene-manifest.v1'],
  generators: ['silhouette.v1'],
  families: ['terraced.v1', 'ridged.v1', 'archipelago.v1'],
  detail: 'full',
  reducedMotion: false,
};
const input = { selection: { kind: 'universe' as const }, capabilities };
const reference = { universeId: uuid, privacyEpoch: 2, manifestSceneRevision: 1, chunkId, chunkSceneRevision: 1 };
const chunkInput = { ...input, reference };
const revisions = {
  geographyRevision: 0,
  structureRevision: 0,
  activityRevision: 0,
  sceneRevision: 1,
  personalRevision: 5,
};
const base = {
  ...input,
  scope: { universeId: uuid, privacyEpoch: 2, personalWatermark: 7 },
  recordedAt: '2026-10-21T00:00:00.000Z',
  currentGeography: { revision: 0, structureRevision: 0, activityRevision: 0 },
};
const manifest: SceneManifestRead = {
  ...base,
  version: 'scene-manifest-read.v1',
  status: 'empty',
  sceneRevision: 0,
  manifest: { schemaVersion: 'scene-manifest.v1', revisions: { ...revisions, sceneRevision: 0 }, chunks: [] },
};
const chunk: SceneChunkRead = {
  ...base,
  version: 'scene-chunk-read.v1',
  status: 'ready',
  sceneRevision: 1,
  reference,
  chunk: SceneChunkSchema.parse({ schemaVersion: 'scene-chunk.v1', chunkId, revisions, objects: [], routes: [] }),
};
async function admittedRequest(): Promise<Request> {
  const request = {
    path: '/v1/universe/scenes/manifest/read',
    headers: { 'x-ks-scope': `${accountId}:2` },
  } as unknown as Request;
  const next = vi.fn();
  await scopeGuard({
    callers: { resolve: () => Promise.resolve(caller), sessionValid: () => Promise.resolve(true) },
    logEvent: () => undefined,
  })(request, {} as Response, next);
  expect(next).toHaveBeenCalledOnce();
  return request;
}
function wired() {
  const read = vi.fn<ReadOwnSceneManifest>(() => Promise.resolve({ kind: 'read', scene: manifest })),
    piece = vi.fn<ReadOwnSceneChunk>(() => Promise.resolve({ kind: 'read', scene: chunk }));
  return { controller: new ScenesController(read, piece), read, piece };
}
describe('Scene guarded readonly HTTP adapter', () => {
  it('dispatches only its matching port with admitted authority and unchanged canonical data', async () => {
    const { controller, read, piece } = wired(),
      r = await admittedRequest();
    expect(await call(controller.manifestRoute(r), input)).toEqual(manifest);
    expect(read).toHaveBeenCalledExactlyOnceWith(authority, input);
    expect(piece).not.toHaveBeenCalled();
    expect(await call(controller.chunkRoute(r), chunkInput)).toEqual(chunk);
    expect(piece).toHaveBeenCalledExactlyOnceWith(authority, chunkInput);
    expect(read).toHaveBeenCalledOnce();
  });
  it('refuses unguarded requests before dispatch', async () => {
    const { controller, read, piece } = wired();
    await expect(call(controller.manifestRoute({} as Request), input)).rejects.toThrow('without the scope guard');
    await expect(call(controller.chunkRoute({} as Request), chunkInput)).rejects.toThrow('without the scope guard');
    expect(read).not.toHaveBeenCalled();
    expect(piece).not.toHaveBeenCalled();
  });
  it('maps every backend refusal without private extras', async () => {
    const r = await admittedRequest();
    for (const reason of ['scope_refused', 'selection_not_found'] as const) {
      const controller = new ScenesController(
        () => Promise.resolve({ kind: 'refused', reason }),
        () => Promise.resolve({ kind: 'refused', reason }),
      );
      const expected = { code: reason === 'scope_refused' ? 'UNIVERSE_UNAVAILABLE' : 'NOT_FOUND', data: {} };
      await expect(call(controller.manifestRoute(r), input)).rejects.toMatchObject(expected);
      await expect(call(controller.chunkRoute(r), chunkInput)).rejects.toMatchObject(expected);
    }
    const controller = new ScenesController(
      () => Promise.resolve({ kind: 'read', scene: manifest }),
      () => Promise.resolve({ kind: 'refused', reason: 'reference_not_found' }),
    );
    await expect(call(controller.chunkRoute(r), chunkInput)).rejects.toMatchObject({ code: 'NOT_FOUND', data: {} });
  });
  it('refuses command/cursor/authority fields, malformed capabilities and inconsistent refs before dispatch', async () => {
    const { controller, read, piece } = wired(),
      r = await admittedRequest();
    for (const extra of [{ accountId }, { commandId: uuid }, { cursor: { universeId: uuid } }]) {
      await expect(call(controller.manifestRoute(r), { ...input, ...extra })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
      await expect(call(controller.chunkRoute(r), { ...chunkInput, ...extra })).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    }
    for (const caps of [
      { ...capabilities, detail: 'invalid' },
      { ...capabilities, generators: ['silhouette.v1', 'silhouette.v1'] },
      { ...capabilities, generators: Array.from({ length: 9 }, () => 'silhouette.v1') },
    ])
      await expect(call(controller.manifestRoute(r), { ...input, capabilities: caps } as never)).rejects.toMatchObject({
        code: 'BAD_REQUEST',
      });
    await expect(
      call(controller.chunkRoute(r), { ...chunkInput, reference: { ...reference, chunkSceneRevision: 2 } }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    expect(read).not.toHaveBeenCalled();
    expect(piece).not.toHaveBeenCalled();
  });
  it('passes explicit unsupported/unavailable states and rejects malformed or cross-scope backend output', async () => {
    const r = await admittedRequest();
    const unsupported = {
      ...manifest,
      status: 'unsupported_version' as const,
      capabilities: { ...capabilities, generators: [] },
    };
    const { manifest: ignored, ...fields } = unsupported;
    void ignored;
    const { chunk: ignoredChunk, ...chunkFields } = chunk;
    void ignoredChunk;
    const unavailable: SceneChunkRead = { ...chunkFields, status: 'unavailable', reason: 'stale_manifest' };
    const controller = new ScenesController(
      () => Promise.resolve({ kind: 'read', scene: fields }),
      () => Promise.resolve({ kind: 'read', scene: unavailable }),
    );
    expect(await call(controller.manifestRoute(r), { ...input, capabilities: fields.capabilities })).toEqual(fields);
    expect(await call(controller.chunkRoute(r), chunkInput)).toEqual(unavailable);
    const bad = new ScenesController(
      () => Promise.resolve({ kind: 'read', scene: { ...manifest, scope: { ...manifest.scope, universeId: 'bad' } } }),
      () => Promise.resolve({ kind: 'read', scene: { ...chunk, reference: { ...reference, privacyEpoch: 1 } } }),
    );
    await expect(call(bad.manifestRoute(r), input)).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
    await expect(call(bad.chunkRoute(r), chunkInput)).rejects.toMatchObject({ code: 'INTERNAL_SERVER_ERROR' });
  });
});

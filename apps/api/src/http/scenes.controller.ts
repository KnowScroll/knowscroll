import { Controller, Header, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request } from 'express';
import { apiContract, type ProblemCode } from '@knowscroll/contracts';
import {
  READ_OWN_SCENE_MANIFEST,
  READ_OWN_SCENE_CHUNK,
  READ_OWN_SCENE_SKY,
  type ReadOwnSceneManifest,
  type ReadOwnSceneChunk,
  type ReadOwnSceneSky,
} from '@knowscroll/backend/modules/scenes';
import { authorityOf } from './callers.js';
import { problem } from './problems.js';
import { admittedCaller } from './scope-guard.js';

type ReadRefusal = Extract<
  Awaited<ReturnType<ReadOwnSceneManifest | ReadOwnSceneChunk | ReadOwnSceneSky>>,
  { kind: 'refused' }
>['reason'];
const refusalProblems: Record<ReadRefusal, ProblemCode> = {
  scope_refused: 'UNIVERSE_UNAVAILABLE',
  selection_not_found: 'NOT_FOUND',
  reference_not_found: 'NOT_FOUND',
};

/** Own-scope appearance reads only. References confer no authority and reads schedule no work. */
@Controller()
export class ScenesController {
  constructor(
    @Inject(READ_OWN_SCENE_MANIFEST) private readonly readManifest: ReadOwnSceneManifest,
    @Inject(READ_OWN_SCENE_CHUNK) private readonly readChunk: ReadOwnSceneChunk,
    @Inject(READ_OWN_SCENE_SKY) private readonly readSky: ReadOwnSceneSky,
  ) {}

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.scenes.manifest)
  manifestRoute(@Req() request: Request) {
    return implement(apiContract.scenes.manifest).handler(async ({ input }) => {
      const result = await this.readManifest(authorityOf(admittedCaller(request)), input);
      if (result.kind === 'refused') throw problem(refusalProblems[result.reason]);
      return result.scene;
    });
  }

  /** The sky of a map at scale: every system, a page at a time (D-417). */
  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.scenes.sky)
  skyRoute(@Req() request: Request) {
    return implement(apiContract.scenes.sky).handler(async ({ input }) => {
      const result = await this.readSky(authorityOf(admittedCaller(request)), input);
      if (result.kind === 'refused') throw problem(refusalProblems[result.reason]);
      return result.scene;
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.scenes.chunk)
  chunkRoute(@Req() request: Request) {
    return implement(apiContract.scenes.chunk).handler(async ({ input }) => {
      const result = await this.readChunk(authorityOf(admittedCaller(request)), input);
      if (result.kind === 'refused') throw problem(refusalProblems[result.reason]);
      return result.scene;
    });
  }
}

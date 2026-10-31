import { Controller, Header, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request } from 'express';
import { apiContract } from '@knowscroll/contracts';
import { THREAD_USE_CASES, type SocialResult, type ThreadUseCases } from '@knowscroll/backend/modules/social';
import { authorityOf } from './callers.js';
import { admittedCaller } from './scope-guard.js';
import { socialRefusal } from './social-problems.js';

/** A refusal becomes its closed Social problem; nothing else about why it was refused is said. */
function value<T>(result: SocialResult<T>): T {
  if (result.kind === 'refused') throw socialRefusal(result.code);
  return result.value;
}

/**
 * `/v1/social/threads/*`: content threads, their invitations, messages and snippets. Handlers only
 * authenticate (the scope guard already admitted the caller) and map the use cases' outcomes;
 * authority is rechecked inside each use case.
 */
@Controller()
export class ThreadsController {
  constructor(@Inject(THREAD_USE_CASES) private readonly useCases: ThreadUseCases) {}

  private authority(request: Request) {
    return authorityOf(admittedCaller(request));
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.threads.create)
  createRoute(@Req() request: Request) {
    return implement(apiContract.threads.create).handler(async ({ input }) =>
      value(await this.useCases.create(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.threads.read)
  readRoute(@Req() request: Request) {
    return implement(apiContract.threads.read).handler(async ({ input }) =>
      value(await this.useCases.read(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.threads.history)
  historyRoute(@Req() request: Request) {
    return implement(apiContract.threads.history).handler(async ({ input }) =>
      value(await this.useCases.history(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.threads.changes)
  changesRoute(@Req() request: Request) {
    return implement(apiContract.threads.changes).handler(async ({ input }) =>
      value(await this.useCases.changes(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.threads.send)
  sendRoute(@Req() request: Request) {
    return implement(apiContract.threads.send).handler(async ({ input }) =>
      value(await this.useCases.send(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.threads.react)
  reactRoute(@Req() request: Request) {
    return implement(apiContract.threads.react).handler(async ({ input }) =>
      value(await this.useCases.react(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.threads.respond)
  respondRoute(@Req() request: Request) {
    return implement(apiContract.threads.respond).handler(async ({ input }) =>
      value(await this.useCases.respond(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.threads.markRead)
  markReadRoute(@Req() request: Request) {
    return implement(apiContract.threads.markRead).handler(async ({ input }) =>
      value(await this.useCases.markRead(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.threads.leave)
  leaveRoute(@Req() request: Request) {
    return implement(apiContract.threads.leave).handler(async ({ input }) =>
      value(await this.useCases.leave(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.threads.inbox)
  inboxRoute(@Req() request: Request) {
    return implement(apiContract.threads.inbox).handler(async ({ input }) =>
      value(await this.useCases.inbox(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.threads.places)
  placesRoute(@Req() request: Request) {
    return implement(apiContract.threads.places).handler(async ({ input }) =>
      value(await this.useCases.places(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.threads.setPlace)
  setPlaceRoute(@Req() request: Request) {
    return implement(apiContract.threads.setPlace).handler(async ({ input }) =>
      value(await this.useCases.setPlace(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.threads.setPlaceHidden)
  setPlaceHiddenRoute(@Req() request: Request) {
    return implement(apiContract.threads.setPlaceHidden).handler(async ({ input }) =>
      value(await this.useCases.setPlaceHidden(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.threads.calls)
  callsRoute(@Req() request: Request) {
    return implement(apiContract.threads.calls).handler(async ({ input }) =>
      value(await this.useCases.calls(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.threads.lockCall)
  lockCallRoute(@Req() request: Request) {
    return implement(apiContract.threads.lockCall).handler(async ({ input }) =>
      value(await this.useCases.lockCall(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.threads.openSnippet)
  openSnippetRoute(@Req() request: Request) {
    return implement(apiContract.threads.openSnippet).handler(async ({ input }) =>
      value(await this.useCases.openSnippet(this.authority(request), input)),
    );
  }
}

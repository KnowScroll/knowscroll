import { Controller, Header, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request } from 'express';
import { apiContract } from '@knowscroll/contracts';
import {
  CONVERSATION_USE_CASES,
  type ConversationUseCases,
  type SocialResult,
} from '@knowscroll/backend/modules/social';
import { authorityOf } from './callers.js';
import { admittedCaller } from './scope-guard.js';
import { socialRefusal } from './social-problems.js';

/** A refusal becomes its closed Social problem; nothing else about why it was refused is said. */
function value<T>(result: SocialResult<T>): T {
  if (result.kind === 'refused') throw socialRefusal(result.code);
  return result.value;
}

/**
 * `/v1/social/conversations/*` and `/v1/social/content-shares/*`: direct conversations and managed
 * share links. Handlers only authenticate (the scope guard already admitted the caller) and map
 * the use cases' outcomes; authority is rechecked inside each use case.
 */
@Controller()
export class ConversationsController {
  constructor(@Inject(CONVERSATION_USE_CASES) private readonly useCases: ConversationUseCases) {}

  private authority(request: Request) {
    return authorityOf(admittedCaller(request));
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.conversations.start)
  startRoute(@Req() request: Request) {
    return implement(apiContract.conversations.start).handler(async ({ input }) =>
      value(await this.useCases.conversations.start(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.conversations.inbox)
  inboxRoute(@Req() request: Request) {
    return implement(apiContract.conversations.inbox).handler(async ({ input }) =>
      value(await this.useCases.conversations.inbox(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.conversations.read)
  readRoute(@Req() request: Request) {
    return implement(apiContract.conversations.read).handler(async ({ input }) =>
      value(await this.useCases.conversations.read(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.conversations.history)
  historyRoute(@Req() request: Request) {
    return implement(apiContract.conversations.history).handler(async ({ input }) =>
      value(await this.useCases.conversations.history(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.conversations.changes)
  changesRoute(@Req() request: Request) {
    return implement(apiContract.conversations.changes).handler(async ({ input }) =>
      value(await this.useCases.conversations.changes(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.conversations.send)
  sendRoute(@Req() request: Request) {
    return implement(apiContract.conversations.send).handler(async ({ input }) =>
      value(await this.useCases.conversations.send(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.conversations.readOwnSend)
  readOwnSendRoute(@Req() request: Request) {
    return implement(apiContract.conversations.readOwnSend).handler(async ({ input }) =>
      value(await this.useCases.conversations.readOwnSend(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.conversations.react)
  reactRoute(@Req() request: Request) {
    return implement(apiContract.conversations.react).handler(async ({ input }) =>
      value(await this.useCases.conversations.react(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.conversations.markRead)
  markReadRoute(@Req() request: Request) {
    return implement(apiContract.conversations.markRead).handler(async ({ input }) =>
      value(await this.useCases.conversations.markRead(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.conversations.mute)
  muteRoute(@Req() request: Request) {
    return implement(apiContract.conversations.mute).handler(async ({ input }) =>
      value(await this.useCases.conversations.mute(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.conversations.leave)
  leaveRoute(@Req() request: Request) {
    return implement(apiContract.conversations.leave).handler(async ({ input }) =>
      value(await this.useCases.conversations.leave(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.contentShares.create)
  createShareRoute(@Req() request: Request) {
    return implement(apiContract.contentShares.create).handler(async ({ input }) =>
      value(await this.useCases.shares.create(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.contentShares.revoke)
  revokeShareRoute(@Req() request: Request) {
    return implement(apiContract.contentShares.revoke).handler(async ({ input }) =>
      value(await this.useCases.shares.revoke(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.contentShares.own)
  ownShareRoute(@Req() request: Request) {
    return implement(apiContract.contentShares.own).handler(async ({ input }) =>
      value(await this.useCases.shares.readOwn(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.contentShares.list)
  listSharesRoute(@Req() request: Request) {
    return implement(apiContract.contentShares.list).handler(async ({ input }) =>
      value(await this.useCases.shares.list(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.contentShares.resolve)
  resolveShareRoute(@Req() request: Request) {
    return implement(apiContract.contentShares.resolve).handler(async ({ input }) =>
      value(await this.useCases.shares.resolve(this.authority(request), input)),
    );
  }
}

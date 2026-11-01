import { Controller, Header, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request } from 'express';
import { apiContract } from '@knowscroll/contracts';
import { ROOM_USE_CASES, type RoomResult, type RoomUseCases } from '@knowscroll/backend/modules/rooms';
import { authorityOf } from './callers.js';
import { admittedCaller } from './scope-guard.js';
import { socialProblem } from './social-problems.js';

/**
 * A refusal becomes one of Social's closed problems; nothing else about why it was refused is said.
 * Only the daily bound on asking an AI inhabitant has its own answer, because the person can act on it.
 */
function value<T>(result: RoomResult<T>): T {
  if (result.kind === 'ok') return result.value;
  switch (result.code) {
    case 'invalid_input':
      throw socialProblem('INVALID_REQUEST');
    case 'command_key_reused':
      throw socialProblem('COMMAND_KEY_REUSED');
    case 'rate_limited':
      throw socialProblem('TOO_MANY_REQUESTS');
    case 'unavailable':
      throw socialProblem('SHARING_UNAVAILABLE');
  }
}

/**
 * `/v1/rooms/*`: idea rooms, their discussions and messages, moderation and the ask of a labelled AI
 * inhabitant. Handlers only authenticate (the scope guard already admitted the caller) and map the use
 * cases' outcomes; authority is rechecked inside each use case.
 */
@Controller()
export class RoomsController {
  constructor(@Inject(ROOM_USE_CASES) private readonly useCases: RoomUseCases) {}

  private authority(request: Request) {
    return authorityOf(admittedCaller(request));
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.list)
  listRoute(@Req() request: Request) {
    return implement(apiContract.rooms.list).handler(async ({ input }) =>
      value(await this.useCases.list(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.read)
  readRoute(@Req() request: Request) {
    return implement(apiContract.rooms.read).handler(async ({ input }) =>
      value(await this.useCases.read(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.join)
  joinRoute(@Req() request: Request) {
    return implement(apiContract.rooms.join).handler(async ({ input }) =>
      value(await this.useCases.join(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.leave)
  leaveRoute(@Req() request: Request) {
    return implement(apiContract.rooms.leave).handler(async ({ input }) =>
      value(await this.useCases.leave(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.invite)
  inviteRoute(@Req() request: Request) {
    return implement(apiContract.rooms.invite).handler(async ({ input }) =>
      value(await this.useCases.invite(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.moderate)
  moderateRoute(@Req() request: Request) {
    return implement(apiContract.rooms.moderate).handler(async ({ input }) =>
      value(await this.useCases.moderate(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.preferences)
  preferencesRoute(@Req() request: Request) {
    return implement(apiContract.rooms.preferences).handler(async ({ input }) =>
      value(await this.useCases.setPreferences(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.presence)
  presenceRoute(@Req() request: Request) {
    return implement(apiContract.rooms.presence).handler(async ({ input }) =>
      value(await this.useCases.setPresence(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.createDiscussion)
  createDiscussionRoute(@Req() request: Request) {
    return implement(apiContract.rooms.createDiscussion).handler(async ({ input }) =>
      value(await this.useCases.create(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.readDiscussion)
  readDiscussionRoute(@Req() request: Request) {
    return implement(apiContract.rooms.readDiscussion).handler(async ({ input }) =>
      value(await this.useCases.readDiscussion(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.history)
  historyRoute(@Req() request: Request) {
    return implement(apiContract.rooms.history).handler(async ({ input }) =>
      value(await this.useCases.history(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.changes)
  changesRoute(@Req() request: Request) {
    return implement(apiContract.rooms.changes).handler(async ({ input }) =>
      value(await this.useCases.changes(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.send)
  sendRoute(@Req() request: Request) {
    return implement(apiContract.rooms.send).handler(async ({ input }) =>
      value(await this.useCases.send(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.openSnippet)
  openSnippetRoute(@Req() request: Request) {
    return implement(apiContract.rooms.openSnippet).handler(async ({ input }) =>
      value(await this.useCases.openSnippet(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.pin)
  pinRoute(@Req() request: Request) {
    return implement(apiContract.rooms.pin).handler(async ({ input }) =>
      value(await this.useCases.pin(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.hideMessage)
  hideMessageRoute(@Req() request: Request) {
    return implement(apiContract.rooms.hideMessage).handler(async ({ input }) =>
      value(await this.useCases.hideMessage(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.markUseful)
  markUsefulRoute(@Req() request: Request) {
    return implement(apiContract.rooms.markUseful).handler(async ({ input }) =>
      value(await this.useCases.markUseful(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.topics)
  topicsRoute(@Req() request: Request) {
    return implement(apiContract.rooms.topics).handler(async ({ input }) =>
      value(await this.useCases.topics(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.dismissAway)
  dismissAwayRoute(@Req() request: Request) {
    return implement(apiContract.rooms.dismissAway).handler(async ({ input }) =>
      value(await this.useCases.dismissAway(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.reports)
  reportsRoute(@Req() request: Request) {
    return implement(apiContract.rooms.reports).handler(async ({ input }) =>
      value(await this.useCases.reports(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.askInhabitant)
  askInhabitantRoute(@Req() request: Request) {
    return implement(apiContract.rooms.askInhabitant).handler(async ({ input }) =>
      value(await this.useCases.ask(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.stations)
  stationsRoute(@Req() request: Request) {
    return implement(apiContract.rooms.stations).handler(async ({ input }) =>
      value(await this.useCases.stations(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.activities)
  activitiesRoute(@Req() request: Request) {
    return implement(apiContract.rooms.activities).handler(async ({ input }) =>
      value(await this.useCases.activities(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.readActivity)
  readActivityRoute(@Req() request: Request) {
    return implement(apiContract.rooms.readActivity).handler(async ({ input }) =>
      value(await this.useCases.readActivity(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.createActivity)
  createActivityRoute(@Req() request: Request) {
    return implement(apiContract.rooms.createActivity).handler(async ({ input }) =>
      value(await this.useCases.createActivity(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.votePoll)
  votePollRoute(@Req() request: Request) {
    return implement(apiContract.rooms.votePoll).handler(async ({ input }) =>
      value(await this.useCases.votePoll(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.moderateActivity)
  moderateActivityRoute(@Req() request: Request) {
    return implement(apiContract.rooms.moderateActivity).handler(async ({ input }) =>
      value(await this.useCases.moderateActivity(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.today)
  todayRoute(@Req() request: Request) {
    return implement(apiContract.rooms.today).handler(async ({ input }) =>
      value(await this.useCases.today(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.solveFlaw)
  solveFlawRoute(@Req() request: Request) {
    return implement(apiContract.rooms.solveFlaw).handler(async ({ input }) =>
      value(await this.useCases.solveFlaw(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.sky)
  skyRoute(@Req() request: Request) {
    return implement(apiContract.rooms.sky).handler(async ({ input }) =>
      value(await this.useCases.sky(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.nameConstellation)
  nameConstellationRoute(@Req() request: Request) {
    return implement(apiContract.rooms.nameConstellation).handler(async ({ input }) =>
      value(await this.useCases.nameConstellation(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.voteDebate)
  voteDebateRoute(@Req() request: Request) {
    return implement(apiContract.rooms.voteDebate).handler(async ({ input }) =>
      value(await this.useCases.voteDebate(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.launch)
  launchRoute(@Req() request: Request) {
    return implement(apiContract.rooms.launch).handler(async ({ input }) =>
      value(await this.useCases.launch(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.startLaunch)
  startLaunchRoute(@Req() request: Request) {
    return implement(apiContract.rooms.startLaunch).handler(async ({ input }) =>
      value(await this.useCases.startLaunch(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.joinLaunch)
  joinLaunchRoute(@Req() request: Request) {
    return implement(apiContract.rooms.joinLaunch).handler(async ({ input }) =>
      value(await this.useCases.joinLaunch(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.answerLaunch)
  answerLaunchRoute(@Req() request: Request) {
    return implement(apiContract.rooms.answerLaunch).handler(async ({ input }) =>
      value(await this.useCases.answerLaunch(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.finishLaunch)
  finishLaunchRoute(@Req() request: Request) {
    return implement(apiContract.rooms.finishLaunch).handler(async ({ input }) =>
      value(await this.useCases.finishLaunch(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.watch)
  watchRoute(@Req() request: Request) {
    return implement(apiContract.rooms.watch).handler(async ({ input }) =>
      value(await this.useCases.watch(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.watchReels)
  watchReelsRoute(@Req() request: Request) {
    return implement(apiContract.rooms.watchReels).handler(async ({ input }) =>
      value(await this.useCases.watchReels(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.startWatch)
  startWatchRoute(@Req() request: Request) {
    return implement(apiContract.rooms.startWatch).handler(async ({ input }) =>
      value(await this.useCases.startWatch(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.joinWatch)
  joinWatchRoute(@Req() request: Request) {
    return implement(apiContract.rooms.joinWatch).handler(async ({ input }) =>
      value(await this.useCases.joinWatch(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.leaveWatch)
  leaveWatchRoute(@Req() request: Request) {
    return implement(apiContract.rooms.leaveWatch).handler(async ({ input }) =>
      value(await this.useCases.leaveWatch(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.stopWatch)
  stopWatchRoute(@Req() request: Request) {
    return implement(apiContract.rooms.stopWatch).handler(async ({ input }) =>
      value(await this.useCases.stopWatch(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.feed)
  feedRoute(@Req() request: Request) {
    return implement(apiContract.rooms.feed).handler(async ({ input }) =>
      value(await this.useCases.feed(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.replay)
  replayRoute(@Req() request: Request) {
    return implement(apiContract.rooms.replay).handler(async ({ input }) =>
      value(await this.useCases.replay(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.setScout)
  setScoutRoute(@Req() request: Request) {
    return implement(apiContract.rooms.setScout).handler(async ({ input }) =>
      value(await this.useCases.setScout(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.replaceMemory)
  replaceMemoryRoute(@Req() request: Request) {
    return implement(apiContract.rooms.replaceMemory).handler(async ({ input }) =>
      value(await this.useCases.replaceMemory(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.replayRound)
  replayRoundRoute(@Req() request: Request) {
    return implement(apiContract.rooms.replayRound).handler(async ({ input }) =>
      value(await this.useCases.replayRound(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.leaveQuestion)
  leaveQuestionRoute(@Req() request: Request) {
    return implement(apiContract.rooms.leaveQuestion).handler(async ({ input }) =>
      value(await this.useCases.leaveQuestion(this.authority(request), input)),
    );
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.rooms.questionNotice)
  questionNoticeRoute(@Req() request: Request) {
    return implement(apiContract.rooms.questionNotice).handler(async ({ input }) =>
      value(await this.useCases.questionNotice(this.authority(request), input)),
    );
  }
}

import { Controller, Header, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request } from 'express';
import {
  UuidSchema,
  apiContract,
  type JourneyResponse,
  type OperatorPanelsResponse,
  type ReviewRejectResult,
  type ReviewReleaseResult,
} from '@knowscroll/contracts';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import {
  IS_OPERATOR,
  READ_JOURNEY,
  READ_OPERATOR_PANELS,
  type IsOperator,
  type Journey,
  type OperatorPanels,
  type Piece,
  type QueueRow,
  type ReadJourney,
  type ReadOperatorPanels,
} from '@knowscroll/backend/modules/operator';
import {
  OPERATOR_REVIEW,
  type OperatorReview,
  type ReviewNotFound,
  type ReviewTarget,
} from '@knowscroll/backend/modules/content';
import { UNPROMPTED_CAPS } from '@knowscroll/backend/modules/rooms';
import { LOG_EVENT } from '../tokens.js';
import { problem } from './problems.js';
import { admittedCaller } from './scope-guard.js';

/** The route's asset and revision, or `undefined` when either is malformed. Parsed only after the operator is known. */
function reviewTargetOf(input: { readonly assetId: string; readonly revision: string }): ReviewTarget | undefined {
  const assetId = UuidSchema.safeParse(input.assetId);
  const revision = /^[1-9][0-9]{0,6}$/.test(input.revision) ? Number(input.revision) : undefined;
  return assetId.success && revision !== undefined ? { assetId: assetId.data.toLowerCase(), revision } : undefined;
}

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date === null ? null : iso(date));

/** Maps a piece's rows to the wire; an unavailable piece passes through. */
function mapPiece<From, To>(source: Piece<From>, map: (data: From) => To): Piece<To> {
  return source.status === 'available' ? { status: 'available', data: map(source.data) } : source;
}

function wirePanels(panels: OperatorPanels): OperatorPanelsResponse {
  const { overview, production, universeChange, safety, privacy, rooms } = panels;
  const queueRows = (rows: readonly QueueRow[]) =>
    rows.map((row) => ({ ...row, lastCompletedAt: isoOrNull(row.lastCompletedAt) }));
  return {
    generatedAt: iso(panels.generatedAt),
    overview: {
      queues: mapPiece(overview.queues, queueRows),
      providerOutcomes: mapPiece(overview.providerOutcomes, (rows) => rows.map((row) => ({ ...row }))),
      recentErrors: mapPiece(overview.recentErrors, (rows) =>
        rows.map((row) => ({ ...row, occurredAt: iso(row.occurredAt) })),
      ),
      serviceHealth: overview.serviceHealth,
      requestLatency: overview.requestLatency,
      mediaDisk: overview.mediaDisk,
    },
    production: {
      runs: mapPiece(production.runs, (rows) =>
        rows.map((row) => ({ ...row, createdAt: iso(row.createdAt), completedAt: isoOrNull(row.completedAt) })),
      ),
      refusedAnswers: mapPiece(production.refusedAnswers, (rows) =>
        rows.map((row) => ({ ...row, issueCodes: [...row.issueCodes], recordedAt: iso(row.recordedAt) })),
      ),
      reelOrders: mapPiece(production.reelOrders, (rows) =>
        rows.map((row) => ({ ...row, createdAt: iso(row.createdAt), publishedAt: isoOrNull(row.publishedAt) })),
      ),
      usage: production.usage,
      plannedDemand: mapPiece(production.plannedDemand, (summary) => ({
        windowDays: summary.windowDays,
        counts: summary.counts.map((row) => ({ ...row })),
      })),
    },
    universeChange: {
      cartographer: mapPiece(universeChange.cartographer, (summary) => ({
        counts: summary.counts.map((row) => ({ ...row })),
        recent: summary.recent.map((row) => ({ ...row, updatedAt: iso(row.updatedAt) })),
      })),
    },
    safety: {
      reports: mapPiece(safety.reports, (summary) => ({
        last24Hours: summary.last24Hours,
        recent: summary.recent.map((row) => ({ ...row, createdAt: iso(row.createdAt) })),
      })),
    },
    rooms: {
      calls: mapPiece(rooms.calls, (summary) => ({
        limits: {
          humanMessagesPerTurn: UNPROMPTED_CAPS.humanMessagesPerTurn,
          roomPerHour: UNPROMPTED_CAPS.roomPerHour,
          roomPerDay: UNPROMPTED_CAPS.roomPerDay,
          explainerPerHour: UNPROMPTED_CAPS.residentPerHour.explainer,
          skepticPerHour: UNPROMPTED_CAPS.residentPerHour.skeptic,
          skepticPerPersonPerHour: UNPROMPTED_CAPS.skepticPerPersonPerHour,
        },
        rooms: summary.rooms.map((row) => ({
          ...row,
          refused: row.refused.map((refusal) => ({ ...refusal })),
          lastAt: iso(row.lastAt),
        })),
      })),
    },
    realtime: panels.realtime,
    privacy: {
      operations: mapPiece(privacy.operations, (summary) => ({
        groups: summary.groups.map((row) => ({ ...row, oldestRequestedAt: iso(row.oldestRequestedAt) })),
        failed: summary.failed.map((row) => ({ ...row, requestedAt: iso(row.requestedAt) })),
      })),
      retentionJobs: mapPiece(privacy.retentionJobs, queueRows),
      droppedDiagnostics: privacy.droppedDiagnostics,
    },
  };
}

function wireJourney(journey: Journey): JourneyResponse {
  return {
    subject: journey.subject,
    subjectId: journey.subjectId,
    steps: journey.steps.map((step) => ({ ...step, at: iso(step.at), endedAt: isoOrNull(step.endedAt) })),
    gaps: journey.gaps.map((gap) => ({ ...gap })),
    truncated: journey.truncated,
  };
}

/**
 * Operator routes (#248, D-044): the panels of the Operator screen, the journey inspector and the review of held
 * Scrolls (#780: list, read, release, reject). Every call checks, on the server, that the signed-in account is an operator of this world
 * (`KS_OPERATOR_ACCOUNTS`); anyone else gets the same 404 as an unknown route and the refusal is
 * logged as a code. The panels and journeys only read, from the allowlisted `ops` views; the review's two decisions are the
 * review gate's own and are logged as `content.review_decided`.
 */
@Controller()
export class OperatorController {
  constructor(
    @Inject(LOG_EVENT) private readonly logEvent: LogEvent,
    @Inject(IS_OPERATOR) private readonly isOperator: IsOperator,
    @Inject(READ_OPERATOR_PANELS) private readonly readPanels: ReadOperatorPanels,
    @Inject(READ_JOURNEY) private readonly readJourney: ReadJourney,
    @Inject(OPERATOR_REVIEW) private readonly review: OperatorReview,
  ) {}

  private async requireOperator(request: Request, route: string): Promise<void> {
    const caller = admittedCaller(request);
    if (await this.isOperator(caller.accountId)) return;
    this.logEvent('operator.refused', { route, reasonCode: 'not_operator' });
    throw problem('NOT_FOUND');
  }

  /**
   * The answer to a review call that found nothing: the same 404 whether the account is no operator or the revision is not held,
   * logged as a code. The use cases check the operator themselves; `requireOperator` runs first only so that a malformed asset or
   * revision is a 400 for an operator and a 404 for anyone else.
   */
  private notFound(route: string, refusal: ReviewNotFound): never {
    if (refusal.why === 'not_operator') this.logEvent('operator.refused', { route, reasonCode: 'not_operator' });
    else this.logEvent('operator.read', { route, outcome: 'not_held' });
    throw problem('NOT_FOUND');
  }

  /** The diagnostic record of a decision, as `content review-release` and `review-reject` keep it: the recipe key, what happened and the revision. */
  private recordDecision(
    recipe: string | null,
    revision: number,
    result: ReviewReleaseResult | ReviewRejectResult,
  ): void {
    this.logEvent('content.review_decided', {
      severity: result.outcome === 'refused' ? 'warn' : 'info',
      context: recipe ?? 'unknown_recipe',
      outcome: result.outcome,
      revision,
      ...(result.reason === null ? {} : { reasonCode: result.reason }),
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.operator.panels)
  panelsRoute(@Req() request: Request) {
    return implement(apiContract.operator.panels).handler(async () => {
      await this.requireOperator(request, '/v1/operator/panels');
      const panels = await this.readPanels();
      this.logEvent('operator.read', { route: '/v1/operator/panels', outcome: 'read' });
      return wirePanels(panels);
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.operator.journey)
  journeyRoute(@Req() request: Request) {
    return implement(apiContract.operator.journey).handler(async ({ input }) => {
      await this.requireOperator(request, '/v1/operator/journeys/{id}');
      // After the operator check, so a malformed ID never tells a non-operator the route exists.
      const id = UuidSchema.safeParse(input.id);
      if (!id.success) throw problem('INVALID_REQUEST');
      const result = await this.readJourney(id.data);
      this.logEvent('operator.read', {
        route: '/v1/operator/journeys/{id}',
        outcome: result.kind,
        ...(result.kind === 'found' ? { count: result.journey.steps.length } : {}),
      });
      if (result.kind === 'not_found') throw problem('NOT_FOUND');
      return wireJourney(result.journey);
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.operator.reviewList)
  reviewListRoute(@Req() request: Request) {
    return implement(apiContract.operator.reviewList).handler(async () => {
      const route = '/v1/operator/review';
      await this.requireOperator(request, route);
      const result = await this.review.list(admittedCaller(request).accountId);
      if (result.kind === 'not_found') this.notFound(route, result);
      this.logEvent('operator.read', { route, outcome: 'read', count: result.revisions.length });
      return { revisions: [...result.revisions] };
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.operator.reviewShow)
  reviewShowRoute(@Req() request: Request) {
    return implement(apiContract.operator.reviewShow).handler(async ({ input }) => {
      const route = '/v1/operator/review/{assetId}/{revision}';
      const caller = admittedCaller(request);
      // After the operator check, so a malformed value never tells a non-operator the route exists.
      await this.requireOperator(request, route);
      const target = reviewTargetOf(input);
      if (target === undefined) throw problem('INVALID_REQUEST');
      const result = await this.review.show(caller.accountId, target);
      if (result.kind === 'not_found') this.notFound(route, result);
      this.logEvent('operator.read', { route, outcome: result.kind });
      if (result.kind === 'unreadable') throw problem('UNPROCESSABLE_REQUEST');
      return result.review;
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.operator.reviewRelease)
  reviewReleaseRoute(@Req() request: Request) {
    return implement(apiContract.operator.reviewRelease).handler(async ({ input }) => {
      const route = '/v1/operator/review/{assetId}/{revision}/release';
      const caller = admittedCaller(request);
      await this.requireOperator(request, route);
      const target = reviewTargetOf(input);
      if (target === undefined) throw problem('INVALID_REQUEST');
      const result = await this.review.release(caller.accountId, target);
      if (result.kind === 'not_found') this.notFound(route, result);
      this.recordDecision(result.recipe, target.revision, result.result);
      return result.result;
    });
  }

  @Header('Cache-Control', 'private, no-store')
  @Implement(apiContract.operator.reviewReject)
  reviewRejectRoute(@Req() request: Request) {
    return implement(apiContract.operator.reviewReject).handler(async ({ input }) => {
      const route = '/v1/operator/review/{assetId}/{revision}/reject';
      const caller = admittedCaller(request);
      await this.requireOperator(request, route);
      const target = reviewTargetOf(input);
      if (target === undefined) throw problem('INVALID_REQUEST');
      const result = await this.review.reject(caller.accountId, target, input.reason ?? '');
      if (result.kind === 'not_found') this.notFound(route, result);
      if (result.kind === 'reason_invalid') throw problem('INVALID_REQUEST');
      this.recordDecision(result.recipe, target.revision, result.result);
      return result.result;
    });
  }
}

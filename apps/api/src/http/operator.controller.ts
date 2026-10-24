import { Controller, Header, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request } from 'express';
import { UuidSchema, apiContract, type JourneyResponse, type OperatorPanelsResponse } from '@knowscroll/contracts';
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
import { LOG_EVENT } from '../tokens.js';
import { problem } from './problems.js';
import { admittedCaller } from './scope-guard.js';

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date === null ? null : iso(date));

/** Maps a piece's rows to the wire; an unavailable piece passes through. */
function mapPiece<From, To>(source: Piece<From>, map: (data: From) => To): Piece<To> {
  return source.status === 'available' ? { status: 'available', data: map(source.data) } : source;
}

function wirePanels(panels: OperatorPanels): OperatorPanelsResponse {
  const { overview, production, universeChange, safety, privacy } = panels;
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
 * Operator routes (#248, D-044): the panels of the Operator screen and the journey inspector.
 * Every call checks, on the server, that the signed-in account is an operator of this world
 * (`KS_OPERATOR_ACCOUNTS`); anyone else gets the same 404 as an unknown route and the refusal is
 * logged as a code. Reads only; the use cases read the allowlisted `ops` views.
 */
@Controller()
export class OperatorController {
  constructor(
    @Inject(LOG_EVENT) private readonly logEvent: LogEvent,
    @Inject(IS_OPERATOR) private readonly isOperator: IsOperator,
    @Inject(READ_OPERATOR_PANELS) private readonly readPanels: ReadOperatorPanels,
    @Inject(READ_JOURNEY) private readonly readJourney: ReadJourney,
  ) {}

  private async requireOperator(request: Request, route: string): Promise<void> {
    const caller = admittedCaller(request);
    if (await this.isOperator(caller.accountId)) return;
    this.logEvent('operator.refused', { route, reasonCode: 'not_operator' });
    throw problem('NOT_FOUND');
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
}

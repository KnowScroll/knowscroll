import { Controller, Inject, Req } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import type { Request } from 'express';
import { apiContract, type ProblemCode } from '@knowscroll/contracts';
import type { ApiConfig } from '@knowscroll/backend/infrastructure/config';
import type { LogEvent } from '@knowscroll/backend/infrastructure/observability';
import type {
  IngestObservations,
  IngestObservationsResult,
  ReadEvidenceDiagnostics,
} from '@knowscroll/backend/modules/evidence';
import { OPERATOR_WORLDS } from '@knowscroll/backend/modules/identity';
import { INGEST_OBSERVATIONS, READ_EVIDENCE_DIAGNOSTICS } from '../modules/evidence.js';
import { API_CONFIG, LOG_EVENT } from '../tokens.js';
import { authorityOf } from './callers.js';
import { problem } from './problems.js';
import { currentRequest } from './request-context.js';
import { admittedCaller } from './scope-guard.js';

const refusalProblems: Record<Extract<IngestObservationsResult, { kind: 'refused' }>['reason'], ProblemCode> = {
  batch_too_large: 'PAYLOAD_TOO_LARGE',
  epoch_changed: 'PRIVACY_EPOCH_CHANGED',
  universe_unavailable: 'UNIVERSE_UNAVAILABLE',
};

/**
 * `POST /v1/observations/batch` (durable intake: stored, not projected) and the dev-only
 * `GET /v1/diagnostics/exposures/{id}/evidence`. Thin handlers over evidence's use cases; the
 * caller is the one the scope guard admitted. The diagnostics route exists only in the worlds that
 * have operator tools (`OPERATOR_WORLDS`: dev, stage, ci, local) and answers 404 anywhere else,
 * live included whatever it is called: an operator surface, never consumer UI.
 */
@Controller()
export class ObservationsController {
  constructor(
    @Inject(INGEST_OBSERVATIONS) private readonly ingestObservations: IngestObservations,
    @Inject(READ_EVIDENCE_DIAGNOSTICS) private readonly readEvidenceDiagnostics: ReadEvidenceDiagnostics,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
    @Inject(LOG_EVENT) private readonly logEvent: LogEvent,
  ) {}

  @Implement(apiContract.observations.submit)
  submitRoute(@Req() request: Request) {
    return implement(apiContract.observations.submit).handler(async ({ input }) => {
      const caller = admittedCaller(request);
      const result = await this.ingestObservations(authorityOf(caller), input);
      if (result.kind === 'refused') throw problem(refusalProblems[result.reason]);
      // After commit, counts and codes only (D-017): never an event, block or exposure.
      this.logEvent('evidence.observations_ingested', {
        ...(currentRequest() === undefined ? {} : { requestId: currentRequest()?.requestId ?? '' }),
        count: result.accepted,
        outcome: 'ingested',
        ...(result.rejected > 0
          ? { reasonCode: 'some_rejected' }
          : result.duplicates > 0
            ? { reasonCode: 'some_duplicates' }
            : {}),
      });
      return {
        accepted: result.accepted,
        duplicates: result.duplicates,
        rejected: result.rejected,
        results: [...result.results],
        revision: result.revision,
      };
    });
  }

  @Implement(apiContract.diagnostics.evidence)
  evidenceDiagnosticsRoute(@Req() request: Request) {
    return implement(apiContract.diagnostics.evidence).handler(async ({ input }) => {
      if (!OPERATOR_WORLDS.includes(this.config.world)) throw problem('NOT_FOUND');
      const caller = admittedCaller(request);
      const result = await this.readEvidenceDiagnostics(authorityOf(caller), input.exposureId);
      if (result.kind === 'refused')
        throw problem(result.reason === 'epoch_changed' ? 'PRIVACY_EPOCH_CHANGED' : 'UNIVERSE_UNAVAILABLE');
      const { diagnostics } = result;
      return {
        revision: diagnostics.revision,
        exposureId: diagnostics.exposureId,
        observations: {
          count: diagnostics.observations.count,
          lastReceivedAt: diagnostics.observations.lastReceivedAt?.toISOString() ?? null,
        },
        evidence:
          diagnostics.evidence === undefined
            ? null
            : {
                revision: diagnostics.evidence.revision,
                inputWatermark: diagnostics.evidence.inputWatermark,
                policyVersion: diagnostics.evidence.policyVersion,
                qualification: diagnostics.evidence.qualification,
                q: diagnostics.evidence.q,
                coverage: diagnostics.evidence.coverage,
                activeDwellMs: diagnostics.evidence.activeDwellMs,
                estimatedReadingMs: diagnostics.evidence.estimatedReadingMs,
                committedAt: diagnostics.evidence.committedAt.toISOString(),
              },
      };
    });
  }
}

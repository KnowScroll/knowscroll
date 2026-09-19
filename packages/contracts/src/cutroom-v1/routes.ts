import type { ErrorResponse } from './errors.ts'
import type { RunRecord } from './record.ts'
import type { SubmitRequest } from './request.ts'
import type { EventsPage, RunResult, RunStatus, SubmitResponse } from './responses.ts'

// What to call, and what comes back — as types only. The engine is reached over HTTP on the
// same machine; the base URL is configuration on both sides (D-098).

export type Routes = {
  'POST /v1/runs': {
    body: SubmitRequest
    responses: {
      202: SubmitResponse
      409: SubmitResponse
      422: SubmitResponse
      500: ErrorResponse
    }
  }
  'GET /v1/runs?requestId=': {
    responses: { 200: RunStatus; 400: ErrorResponse; 404: ErrorResponse; 500: ErrorResponse }
  }
  'GET /v1/runs/:runId': {
    responses: { 200: RunStatus; 404: ErrorResponse; 500: ErrorResponse }
  }
  'GET /v1/runs/:runId/events?since=': {
    responses: { 200: EventsPage; 400: ErrorResponse; 404: ErrorResponse; 500: ErrorResponse }
  }
  'GET /v1/runs/:runId/result': {
    responses: { 200: RunResult; 404: ErrorResponse; 409: RunStatus; 500: ErrorResponse }
  }
  'GET /v1/runs/:runId/record': {
    responses: { 200: RunRecord; 404: ErrorResponse; 409: RunStatus; 500: ErrorResponse }
  }
  'POST /v1/runs/:runId/cancel': {
    responses: { 200: RunStatus; 404: ErrorResponse; 500: ErrorResponse }
  }
}

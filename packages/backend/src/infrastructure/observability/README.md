# infrastructure/observability

The only application logging path (blueprint §26).

- `catalogue.ts`: every diagnostic event name, its severity, module and allowed fields. Adding an
  event is a reviewed change to this file; `logEvent` accepts nothing else (type-checked).
- `createEventLog(options)` → `logEvent(event, fields)`: writes `{schemaVersion: "diagnostic.v1",
  time, level, service, module, environment, revision, event, …fields}` through Pino to stdout
  (journald on the VPS).
- **No free text.** Fields are IDs, codes, route templates, counts, durations, configuration
  problems as `VARIABLE: kind_code`, and sanitised errors. Values outside a field's vocabulary are
  dropped and counted in `rejectedFields`.
- **Journal projection.** Journald cannot erase per person, so personal-linkable IDs (command,
  receipt, job, run, attempt, evidence IDs) are withheld and counted in `withheldFields`. Only the
  per-request ID and trace context remain.
- `sanitiseError`: class (constructor name), stable code (Node/pg/problem codes), stack frames with
  paths shortened to two segments and scrubbed; never the message or other properties. Causes are
  sanitised to depth 3.
- `sanitiseUrl`: removes userinfo and fragments; drops the whole query string when any parameter
  name looks like a credential (presigned URLs, magic links, OAuth callbacks).
- `FrameworkLogAdapter`: Nest's logger interface. Recognised lifecycle messages (module
  initialised, route mapped, gateway subscription, started) become codes plus route/method fields;
  every other message, including every error message, is dropped.
- `canary.test.ts`: secret-shaped values injected into every field of every event, nested error
  causes, URLs, headers and the framework adapter never reach the output. The release journey
  repeats the check on the running API and worker.

Emit success events after commit: a log line is never proof of a committed effect.

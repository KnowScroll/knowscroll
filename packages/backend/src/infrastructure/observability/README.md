# infrastructure/observability

The only application logging path (blueprint §26).

- `catalogue.ts`: every diagnostic event name, its severity, module and allowed fields. Adding an
  event is a reviewed change to this file; `logEvent` accepts nothing else (type-checked).
- `createEventLog(options)` → `logEvent(event, fields)`: writes `{schemaVersion: "diagnostic.v1",
  time, level, service, module, environment, revision, event, …fields}` through Pino to stdout
  (journald on the VPS).
- Field values are validated against the §26 vocabulary (IDs, codes, route templates, counts);
  invalid values are dropped and counted in `rejectedFields`.
- Journal projection: journald cannot erase per person, so personal-linkable IDs (command,
  receipt, job, run, attempt, evidence IDs) are withheld from the journal and counted in
  `withheldFields`. Only the per-request ID and trace context remain.
- `sanitiseError`: class, stable code (Node/pg/problem codes) and stack frames; never the message.
  Causes are sanitised to depth 3.
- `sanitiseUrl`: removes userinfo and fragments; drops the whole query string when any parameter
  name looks like a credential (presigned URLs, magic links, OAuth callbacks).
- `scrubText`: removes credential-shaped substrings from free text (framework messages, frames).
- `FrameworkLogAdapter`: Nest's logger interface mapped onto `framework.message`; error-level
  framework text is dropped, only the sanitised error is kept.

Emit success events after commit: a log line is never proof of a committed effect.

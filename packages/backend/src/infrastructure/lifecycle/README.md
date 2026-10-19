# infrastructure/lifecycle

`runProcess({ start, logEvent, shutdownGraceMs })` runs the API and worker processes:

1. `start()` constructs everything and resolves when the process serves or consumes; a failure
   logs `process.start_failed` and exits 1.
2. The first SIGTERM or SIGINT logs `process.stopping` and calls `stop()` once: stop admission,
   drain bounded work, close listeners, queues and pools.
3. A clean stop logs `process.stopped` and exits 0; a failed or overdue stop
   (`shutdownGraceMs`) logs `process.stop_failed` and exits 1.

Unhandled rejections and uncaught exceptions are logged sanitised and exit 1. Exit status is a
contract with systemd and the CI release tests.

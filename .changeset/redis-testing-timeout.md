---
'@nxgt/redis': minor
---

Add `@nxgt/redis/testing` and a per-call deadline for the guards.

- `@nxgt/redis/testing` exports `startTestRedis(options?)`, which starts a real Redis for a suite on a free port and resolves to `{ uri, reset, stop }` (`reset` is `FLUSHALL`; a second `stop` does nothing), `buildTestRedis(options?)`, which builds it ahead of the suite and resolves to the `redis-server` path, and `TEST_REDIS_VERSION` (7.4.1). `$REDIS_BIN`, or `{ binary }`, names a `redis-server` to run instead, and nothing is built; `{ version, downloadDir }` choose the build. `redis-memory-server` (`>=0.17.1 <0.18`) is a new **optional** peer, used by this subpath alone: install it as a devDependency where a suite imports it. An application that never imports `/testing` installs nothing new.
- `consume`, `enforce` and `peek` take a third argument, `{ timeoutMs }`, and `run` takes `timeoutMs` beside `fingerprint` and `wait`. When Redis has not answered within it, the call rejects with `GuardError` code `TIMEOUT` (new in `GuardErrorCode`), naming the definition, never the key. The command is not withdrawn: a timed-out `consume` or `enforce` may still count its cost, and a `run` whose store timed out may still store its result. A `run` whose key-taking timed out sends a release behind it, so a key the late script took is given back. A `timeoutMs` that is not a whole number of 1 or more rejects with a `TypeError` before anything is sent. New type: `LimitCallOptions`.

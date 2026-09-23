#!/usr/bin/env bun
/**
 * Builds the Redis the specs run against, once, and prints where it is.
 *
 * `@nxgt/redis`'s specs run against a real Redis, started per spec file on a
 * free port, with no Docker. Unlike Meilisearch and mongod there is nothing
 * to download: **neither redis/redis nor valkey publishes a prebuilt binary**,
 * so `redis-memory-server` fetches the source and compiles it. What that
 * costs is measured and written down in one place,
 * `packages/redis/test/server.ts`.
 *
 * That is why it is a script and not something a spec does: that build does
 * not belong inside a test's timeout. The package's `test` script runs this
 * first, the same way `@nxgt/meilisearch`'s runs `scripts/meilisearch.ts`.
 *
 * It holds no logic of its own — `redisBinary` lives beside the server that
 * starts it, so `REDIS_VERSION` and the cache path have one home. Its
 * `$REDIS_BIN` branch is covered by `scripts/redis.spec.ts`.
 *
 * `$REDIS_BIN`, when set, names a `redis-server` to use instead — a system
 * one, or a build for a platform this cannot compile on.
 *
 * Raise the version in `packages/redis/test/server.ts` **and in its two
 * copies, `packages/redis-kit/test/server.ts` and
 * `packages/redis-guard/test/server.ts`**: the three pin the same
 * `REDIS_VERSION`, and CI keys its cache on the hash of all three files and
 * this one. A version raised in one copy alone is a second compile.
 */

import { redisBinary } from '../packages/redis/test/server';

if (import.meta.main) {
	console.log(await redisBinary());
}

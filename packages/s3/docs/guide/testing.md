# Testing against a real S3 API

`@nxgt/s3/testing` starts SeaweedFS for a suite: its S3 gateway, on free
ports, with no Docker and nothing to `bun add`. Specs then run against a real
service — real signatures, real refusals, real listings — instead of a mock
that agrees with whatever you wrote.

It is a subpath: an application that never imports it never loads it, and the
root entry (`@nxgt/s3`) has no trace of it.

## A whole spec

```ts
import { afterAll, beforeAll, beforeEach, expect, test } from 'bun:test';
import { bindBucket, defineBucket } from '@nxgt/s3';
import { startTestS3, type TestS3 } from '@nxgt/s3/testing';

const avatars = defineBucket({
	bucket: 'avatars',
	key: (params: { userId: string }) => `${params.userId}.png`,
	contentType: 'image/png',
	maxSize: 1024,
});

let s3: TestS3;

beforeAll(async () => {
	s3 = await startTestS3();
	await s3.createBucket('avatars');
}, 120_000);

beforeEach(() => s3.reset('avatars'));

afterAll(() => s3.stop());

test('stores and reads back an avatar', async () => {
	const store = bindBucket(avatars, s3.options);
	await store.put({ userId: 'u1' }, new Uint8Array([1, 2, 3]), {
		type: 'image/png',
	});
	expect(await store.bytes({ userId: 'u1' })).toEqual(new Uint8Array([1, 2, 3]));
});
```

## What you get

`startTestS3(options?)` resolves to:

| field | what it is |
| --- | --- |
| `endpoint` | `http://127.0.0.1:<port>` |
| `accessKeyId`, `secretAccessKey`, `region` | the credentials the server accepts (local only), and `us-east-1` |
| `options` | all of the above plus `virtualHostedStyle: false`: pass it as the second argument of `bindBucket` |
| `createBucket(name, { timeoutMs }?)` | creates the bucket and resolves once it takes writes; waits 90 s unless `timeoutMs` is given |
| `reset(bucket, { timeoutMs }?)` | deletes every object of the bucket, so each test starts from nothing; no deadline unless `timeoutMs` is given |
| `stop()` | kills the server and removes its files; a second call does nothing |

A bucket must be created before it is used, and its name must follow S3's
rules (3 to 63 characters, lowercase letters, digits, dots and hyphens,
starting and ending with a letter or digit), or `createBucket` throws at
once. SeaweedFS makes a bucket on the first
write, and readiness is per bucket, so `createBucket` is what waits for it.
Two servers started at once are separate: each has its own ports, data and
buckets.

Forgetting `stop()` does not leave a process behind. The server does not keep
your process alive, so a script that never stops it still ends on its own, and
the server is killed with it. On SIGINT or SIGTERM the server is killed too,
and when yours is the only handler for that signal the process then ends with
the exit code the default would give (`128 + n`). If you register your own
handler, the process keeps your policy: the server is still killed, and
ending the process is yours to do. On those paths the server's temp directory and its unix sockets (which `weed`
puts in `/tmp`, whatever `$TMPDIR` is) are removed too. A `SIGKILL` of your process cannot be
caught and does leave the `weed` running: stop it yourself.

`reset` throws if it cannot list or delete, for a bucket that was never
created included, so create each bucket first.

## Failing fast on a stuck server

Without a deadline, a stuck server hangs `reset` until your runner's hook
timeout (15 s in `bun test`), and the failure says nothing about S3. Pass
`timeoutMs`, a whole number of milliseconds, 1 or more, to get an `S3Error`
with code `TIMEOUT` that names the bucket instead:

```ts
beforeEach(() => s3.reset('avatars', { timeoutMs: 3_000 }));
```

On `reset` the deadline applies to each list and each round of deletes; on
`createBucket` it replaces the 90 s readiness wait, as a total. Keep it under
your hook timeout. A value that is not whole milliseconds throws `WRONG_OPTION`.

## Where the binary comes from

In this order:

1. the `binary` option: `startTestS3({ binary: '/usr/local/bin/weed' })`;
2. the `$WEED_BIN` environment variable;
3. the cache, `<cacheDir>/<version>/weed`, where `version` is
   `TEST_SEAWEEDFS_VERSION` (4.47);
4. a download, once, into that cache.

`cacheDir` defaults to `node_modules/.cache/@nxgt/s3/seaweedfs`, under the
nearest `node_modules` found from `process.cwd()`. Pass `cacheDir` to put it
elsewhere, and cache that folder in CI so the download happens once.

The first run downloads the release archive. Give `beforeAll` a timeout that allows
it (120 s above), or download ahead of the suite from a script your `test`
runs first:

```ts
// test/seaweedfs.ts: "test": "bun run test/seaweedfs.ts && bun test"
import { seaweedfsBinary } from '@nxgt/s3/testing';
console.log(await seaweedfsBinary());
```

## The download is checked

Every release asset of the pinned SeaweedFS version has its SHA-256 pinned in
the package. A download that does not match is refused with an error that
names both hashes, and nothing is unpacked or cached. Raising the version
means raising the table with it. Platforms the release does not ship
(Windows, 32-bit ARM macOS) get an error asking for `$WEED_BIN`.

## Why SeaweedFS

MinIO, the usual choice, no longer publishes a binary (`dl.min.io` answers
`410 Gone`). SeaweedFS does, for Linux, macOS, FreeBSD and OpenBSD, and
`weed server -s3` serves the API Bun's `S3Client` speaks.

Errors you can meet are in [Troubleshooting](../troubleshooting.md#testing).

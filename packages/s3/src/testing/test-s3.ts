import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { freePorts } from './ports';
import { createBucketOn, emptyBucket, type ServerAddress } from './ready';
import { reapOnExit } from './reaper';
import { type SeaweedfsOptions, seaweedfsBinary } from './seaweedfs';
import {
	ACCESS_KEY_ID,
	identities,
	SECRET_ACCESS_KEY,
	socketsOf,
	spawnWeed,
} from './weed';

export type TestS3Options = SeaweedfsOptions;

export interface TestS3 {
	endpoint: string;
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
	/** Options ready for `bindBucket`, pointing at this server. */
	options: ServerAddress;
	/** Creates `name` and resolves once it takes writes. */
	createBucket(name: string): Promise<void>;
	/** Empties a bucket, so each test starts from nothing. */
	reset(bucket: string): Promise<void>;
	/** Kills the server and removes its files. Calling it again does nothing. */
	stop(): Promise<void>;
}

/**
 * A real S3 API for a suite: SeaweedFS's own gateway, started by
 * `weed server -s3` on free ports, with no Docker. The first run downloads
 * the binary into the cache.
 *
 * A server nobody stops does not keep the process alive, and is killed when
 * the process exits or receives SIGINT or SIGTERM.
 */
export async function startTestS3(
	options: TestS3Options = {},
): Promise<TestS3> {
	const binary = await seaweedfsBinary(options);
	const dir = await mkdtemp(join(tmpdir(), 'nxgt-s3-'));
	const ports = await freePorts();

	// `weed` refuses to start when `-dir` is not there — it does not create
	// it, and says so only on stderr, which is why that is captured below.
	const data = join(dir, 'data');
	await mkdir(data, { recursive: true });
	const config = join(dir, 's3.json');
	await Bun.write(config, identities());

	// Its log goes to a file, not a pipe: SeaweedFS is chatty enough to fill
	// the 64 KB pipe buffer in well under a minute, and a pipe nobody drains
	// blocks the process that writes to it — measured, that is a server that
	// starts, serves briefly and then hangs.
	const logPath = join(dir, 'weed.log');
	const child = spawnWeed(binary, data, config, ports, Bun.file(logPath));
	const stop = makeStop(child, dir, ports);

	const address: ServerAddress = {
		endpoint: `http://127.0.0.1:${ports[0]}`,
		accessKeyId: ACCESS_KEY_ID,
		secretAccessKey: SECRET_ACCESS_KEY,
		region: 'us-east-1',
		virtualHostedStyle: false,
	};
	const server = { logPath, exited: child.exited };

	try {
		await createBucketOn(address, 'health', server);
	} catch (error) {
		await stop();
		throw error;
	}

	return {
		endpoint: address.endpoint,
		accessKeyId: ACCESS_KEY_ID,
		secretAccessKey: SECRET_ACCESS_KEY,
		region: address.region,
		options: address,
		createBucket: (name) => createBucketOn(address, name, server),
		reset: (bucket) => emptyBucket(address, bucket),
		stop,
	};
}

/** `stop()`: kills the server, removes its files, and is safe to repeat. */
function makeStop(
	child: Subprocess,
	dir: string,
	ports: number[],
): () => Promise<void> {
	const unreap = reapOnExit(child, [dir, ...socketsOf(ports)]);
	let stopped: Promise<void> | undefined;
	return () => {
		stopped ??= (async () => {
			unreap();
			// `SIGKILL`, not the default `SIGTERM`. Measured on SeaweedFS 4.47:
			// `weed server` takes **20 s** to exit on either SIGTERM or SIGINT —
			// 20078 / 20024 ms and 20015 / 20102 ms over two runs each — and
			// **11 ms** on SIGKILL. That is a fixed shutdown grace period, not a
			// flush: the directory it writes into is removed on the next line.
			child.kill('SIGKILL');
			await child.exited;
			await rm(dir, { recursive: true, force: true });
			// `weed` leaves a unix socket per port it bound; a long-lived CI
			// runner would otherwise collect them.
			await Promise.all(
				socketsOf(ports).map((socket) => rm(socket, { force: true })),
			);
		})();
		return stopped;
	};
}

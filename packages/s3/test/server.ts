import { join } from 'node:path';
import { S3Client } from 'bun';
import { startTestS3 } from '../src/testing';

/**
 * The suite's SeaweedFS cache: the repository's `.cache/seaweedfs`, which
 * `scripts/seaweedfs.ts` fills before the specs and CI caches. The server
 * itself is `@nxgt/s3/testing`'s `startTestS3`.
 */
export const SEAWEEDFS_CACHE = join(
	new URL('../../..', import.meta.url).pathname,
	'.cache',
	'seaweedfs',
);

export interface TestServer {
	endpoint: string;
	/** Options ready for `bindBucket`, pointing at this server. */
	options: Awaited<ReturnType<typeof startTestS3>>['options'];
	/** A client of this server, the specs' own. */
	client: S3Client;
	/** Empties a bucket, so each test starts from nothing. */
	reset(bucket: string): Promise<void>;
	stop(): Promise<void>;
}

/** One SeaweedFS for a spec file, with `buckets` created. */
export async function startS3(buckets: string[] = []): Promise<TestServer> {
	const s3 = await startTestS3({ cacheDir: SEAWEEDFS_CACHE });
	try {
		await Promise.all(buckets.map((name) => s3.createBucket(name)));
	} catch (error) {
		await s3.stop();
		throw error;
	}
	return {
		endpoint: s3.endpoint,
		options: s3.options,
		client: new S3Client({ ...s3.options, bucket: 'health' }),
		reset: s3.reset,
		stop: s3.stop,
	};
}

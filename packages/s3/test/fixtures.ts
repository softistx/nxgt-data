import { afterAll, beforeAll, beforeEach } from 'bun:test';
import { defineBucket } from '../src/bucket/define-bucket';
import { startS3, type TestServer } from './server';

/** Guarded on both counts, so a refusal can be measured. */
export const avatars = defineBucket({
	bucket: 'avatars',
	key: (params: { userId: string }) => `${params.userId}.png`,
	contentType: ['image/png', 'image/jpeg'],
	maxSize: 1024,
});

/** Guarded on neither, so anything can be written. */
export const uploads = defineBucket({
	bucket: 'uploads',
	key: (params: { folder: string; name: string }) =>
		`${params.folder}/${params.name}`,
});

/** Guarded on the content type only, and by a single type. */
export const reports = defineBucket({
	bucket: 'reports',
	key: (id: string) => `${id}.csv`,
	contentType: 'text/csv',
});

export const BUCKETS = ['avatars', 'uploads', 'reports'];

/**
 * One SeaweedFS per spec file, its buckets emptied before each test. It
 * creates a bucket on first write, so there is nothing to set up — and
 * nothing that would give a missing-bucket error either.
 */
export function useS3() {
	const servers = {} as { s3: TestServer };

	beforeAll(async () => {
		servers.s3 = await startS3(BUCKETS);
	}, 120_000);

	beforeEach(async () => {
		await Promise.all(BUCKETS.map((bucket) => servers.s3.reset(bucket)));
	});

	afterAll(async () => {
		await servers.s3?.stop();
	});

	return servers;
}

/** Bytes of a given length, for measuring the size guard. */
export const bytes = (length: number) => new Uint8Array(length).fill(1);

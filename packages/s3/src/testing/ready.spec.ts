import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { rejection } from '../../test/rejection';
import { S3Error } from '../errors/s3-error';
import { createBucketOn, emptyBucket, type ServerAddress } from './ready';

// A server that accepts connections and never answers: the stuck test S3
// server a consumer's hook would otherwise wait on until its own timeout.
let stuck: ReturnType<typeof Bun.serve>;
let address: ServerAddress;

beforeAll(() => {
	stuck = Bun.serve({
		port: 0,
		fetch: () => new Promise<Response>(() => undefined),
	});
	address = {
		endpoint: `http://127.0.0.1:${stuck.port}`,
		accessKeyId: 'key',
		secretAccessKey: 'secret',
		region: 'us-east-1',
		virtualHostedStyle: false,
	};
});

afterAll(async () => {
	await stuck.stop(true);
});

describe('reset and createBucket against a server that never answers', () => {
	test('emptyBucket rejects with TIMEOUT once timeoutMs has passed', async () => {
		const started = Date.now();
		const error = await rejection(
			emptyBucket(address, 'avatars', { timeoutMs: 200 }),
		);
		expect(error).toBeInstanceOf(S3Error);
		expect((error as S3Error).code).toBe('TIMEOUT');
		expect((error as S3Error).message).toContain('avatars');
		expect(Date.now() - started).toBeLessThan(3000);
	});

	test('createBucketOn rejects with TIMEOUT once timeoutMs has passed', async () => {
		const started = Date.now();
		const error = await rejection(
			createBucketOn(
				address,
				'avatars',
				{ logPath: '/nonexistent', exited: new Promise(() => undefined) },
				{ timeoutMs: 200 },
			),
		);
		expect(error).toBeInstanceOf(S3Error);
		expect((error as S3Error).code).toBe('TIMEOUT');
		expect(Date.now() - started).toBeLessThan(3000);
	});

	test('a timeoutMs that is not whole milliseconds is refused as WRONG_OPTION', async () => {
		const error = await rejection(
			emptyBucket(address, 'avatars', { timeoutMs: 0 }),
		);
		expect((error as S3Error).code).toBe('WRONG_OPTION');
	});
});

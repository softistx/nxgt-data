import { afterEach, describe, expect, test } from 'bun:test';
import { avatars, bytes, uploads } from '../../../test/fixtures';
import { rejection, rejectionMessage } from '../../../test/rejection';
import { S3Error } from '../../errors/s3-error';
import { bindBucket } from '../bind-bucket';

const png = bytes(64);
const key = { userId: 'u1' };

/** An endpoint that accepts connections and never answers; counts them. */
function silentEndpoint() {
	const state = { opened: 0, closed: 0 };
	const listener = Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		socket: {
			open() {
				state.opened++;
			},
			data() {},
			close() {
				state.closed++;
			},
		},
	});
	listeners.push(listener);
	return {
		state,
		options: {
			endpoint: `http://127.0.0.1:${listener.port}`,
			accessKeyId: 'k',
			secretAccessKey: 's',
			region: 'us-east-1',
			virtualHostedStyle: false as const,
			retry: 0,
		},
	};
}
const listeners: { stop(force?: boolean): void }[] = [];
afterEach(() => {
	for (const listener of listeners.splice(0)) listener.stop(true);
});
const settle = () => Bun.sleep(150);
const put = { type: 'image/png' } as const;

describe('put and list with no answer in time', () => {
	test('both reject with TIMEOUT, name the call, and abort the request', async () => {
		const { state, options } = silentEndpoint();
		const bucket = bindBucket(avatars, options);
		const started = performance.now();
		const error = await rejection(
			bucket.put(key, png, { ...put, timeoutMs: 200 }),
		);
		const took = performance.now() - started;
		expect(error).toBeInstanceOf(S3Error);
		expect((error as S3Error).code).toBe('TIMEOUT');
		expect((error as S3Error).key).toBe('u1.png');
		expect((error as S3Error).message).toBe(
			'put on "avatars": no answer in 200ms',
		);
		expect(took).toBeGreaterThanOrEqual(190);
		expect(took).toBeLessThan(1000);
		const listing = await rejection(bucket.list({ timeoutMs: 200 }));
		expect(listing).toBeInstanceOf(S3Error);
		expect((listing as S3Error).code).toBe('TIMEOUT');
		expect((listing as S3Error).message).toBe(
			'list on "avatars": no answer in 200ms',
		);
		await settle();
		expect(state.opened).toBe(2);
		expect(state.closed).toBe(2);
	});

	test('the bucket’s default applies, and a call’s own wins', async () => {
		const { options } = silentEndpoint();
		const bucket = bindBucket(avatars, { ...options, timeoutMs: 150 });
		expect(await rejectionMessage(bucket.put(key, png, put))).toBe(
			'put on "avatars": no answer in 150ms',
		);
		expect(await rejectionMessage(bucket.list())).toBe(
			'list on "avatars": no answer in 150ms',
		);
		expect(
			await rejectionMessage(bucket.put(key, png, { ...put, timeoutMs: 250 })),
		).toBe('put on "avatars": no answer in 250ms');
		expect(await rejectionMessage(bucket.list({ timeoutMs: 250 }))).toBe(
			'list on "avatars": no answer in 250ms',
		);
	});

	test('a stream that never ends is cancelled, and nothing more is pulled', async () => {
		const { state, options } = silentEndpoint();
		const bucket = bindBucket(uploads, options);
		const source = { pulls: 0, cancelled: undefined as unknown };
		const endless = () =>
			new ReadableStream<Uint8Array>({
				async pull(controller) {
					source.pulls++;
					await Bun.sleep(1);
					controller.enqueue(new Uint8Array(1024));
				},
				cancel(reason) {
					source.cancelled = reason;
				},
			});
		for (const body of [endless(), new Response(endless())]) {
			source.pulls = 0;
			source.cancelled = undefined;
			expect(
				await rejectionMessage(
					bucket.put({ folder: 'a', name: 'b' }, body as never, {
						timeoutMs: 150,
					}),
				),
			).toBe('put on "uploads": no answer in 150ms');
			await Bun.sleep(30);
			const at = source.pulls;
			expect(source.cancelled).toBeInstanceOf(Error);
			await Bun.sleep(150);
			expect(source.pulls).toBe(at);
		}
		expect(state.opened).toBe(0);
	});

	test('a Bun.file that is not there is Bun’s ENOENT, with its path and no URL', async () => {
		const { state, options } = silentEndpoint();
		const bucket = bindBucket(uploads, options);
		const path = `${import.meta.dir}/no-such-file.bin`;
		const error = (await rejection(
			bucket.put({ folder: 'a', name: 'b' }, Bun.file(path), {
				timeoutMs: 5000,
			}),
		)) as Error & { code: string; path: string };
		expect(error.name).toBe('Error');
		expect(error.code).toBe('ENOENT');
		expect(error.path).toBe(path);
		expect(error.message).toBe(
			`ENOENT: no such file or directory, open '${path}'`,
		);
		expect(Bun.inspect(error)).not.toContain('X-Amz');
		await settle();
		expect(state.opened).toBe(0);
	});
});

describe('a timeoutMs that is not a whole number of milliseconds', () => {
	test('is WRONG_OPTION on put and list, before anything is sent', async () => {
		const { state, options } = silentEndpoint();
		const bucket = bindBucket(avatars, options);
		for (const value of [0, -1, 1.5, '200', null, Number.NaN]) {
			const timeoutMs = value as unknown as number;
			for (const [call, where] of [
				[() => bucket.put(key, png, { ...put, timeoutMs }), 'put'],
				[() => bucket.list({ timeoutMs }), 'list'],
			] as const) {
				const error = await rejection(call());
				expect(error).toBeInstanceOf(S3Error);
				expect((error as S3Error).code).toBe('WRONG_OPTION');
				expect((error as S3Error).message).toStartWith(
					'timeoutMs is a whole number of milliseconds, 1 or more; got ',
				);
				expect((error as S3Error).message).toEndWith(
					` (${where} on "avatars")`,
				);
			}
		}
		await settle();
		expect(state.opened).toBe(0);
	});
});

describe('every guard still answers before anything is sent, under a deadline', () => {
	test('type, size, unmeasurable and option refusals', async () => {
		const { state, options } = silentEndpoint();
		const bucket = bindBucket(avatars, { ...options, timeoutMs: 5000 });
		const code = async (promise: Promise<unknown>) =>
			((await rejection(promise)) as S3Error).code;
		expect(await code(bucket.put(key, png, { type: 'text/plain' }))).toBe(
			'WRONG_TYPE',
		);
		expect(await code(bucket.put(key, bytes(2000), put))).toBe('TOO_LARGE');
		expect(await code(bucket.put(key, new Response('x'), put))).toBe(
			'UNMEASURABLE',
		);
		expect(
			await code(
				bucket.put(key, png, { ...put, acl: 'everyone' as 'private' }),
			),
		).toBe('WRONG_OPTION');
		await settle();
		expect(state.opened).toBe(0);
	});
});

describe('the timer', () => {
	test('leaves nothing pending, whichever way the call ends', async () => {
		const live = new Set<unknown>();
		const { setTimeout: set, clearTimeout: clear } = globalThis;
		globalThis.setTimeout = ((...args: Parameters<typeof set>) => {
			const id = set(...args);
			live.add(id);
			return id;
		}) as typeof set;
		globalThis.clearTimeout = ((id: Parameters<typeof clear>[0]) => {
			live.delete(id);
			return clear(id);
		}) as typeof clear;
		try {
			const { options } = silentEndpoint();
			const bucket = bindBucket(avatars, options);
			await rejection(bucket.put(key, png, { ...put, timeoutMs: 100 }));
			await rejection(bucket.list({ timeoutMs: 100 }));
			await rejection(
				bucket.put(key, png, { ...put, timeoutMs: 100, acl: 'x' as 'private' }),
			);
			expect([...live]).toEqual([]);
		} finally {
			globalThis.setTimeout = set;
			globalThis.clearTimeout = clear;
		}
	});
});

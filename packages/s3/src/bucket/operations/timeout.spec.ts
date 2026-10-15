import { afterEach, describe, expect, test } from 'bun:test';
import { avatars, bytes, uploads, useS3 } from '../../../test/fixtures';
import { rejection, rejectionMessage } from '../../../test/rejection';
import { S3Error } from '../../errors/s3-error';
import { bindBucket } from '../bind-bucket';
import { defineBucket } from '../define-bucket';

const servers = useS3();
const png = bytes(64);
const key = { userId: 'u1' };
const gone = { userId: 'nobody' };

/** An endpoint that accepts connections and never answers; counts closes. */
function silentEndpoint() {
	const state = { closed: 0 };
	const listener = Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		socket: {
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

describe('a call with a deadline gives what the call without one gives', () => {
	test('for an object that is there', async () => {
		const bucket = bindBucket(avatars, servers.s3.options);
		await bucket.put(key, png, { type: 'image/png' });
		const limit = { timeoutMs: 5000 };
		const plain = await bucket.stat(key);
		const timed = await bucket.stat(key, limit);
		expect(plain).toBeDefined();
		expect(timed?.size).toBe(plain?.size ?? -1);
		expect(timed?.etag).toBe(plain?.etag ?? '');
		expect(timed?.type).toBe(plain?.type ?? '');
		expect(timed?.lastModified.getTime()).toBe(plain?.lastModified.getTime());
		expect(await bucket.exists(key, limit)).toBe(true);
		expect(await bucket.bytes(key, limit)).toEqual(png);
		expect(await bucket.bytes(key, limit)).toEqual(await bucket.bytes(key));
		const text = bindBucket(uploads, servers.s3.options);
		await text.put({ folder: 'a', name: 'b.txt' }, 'héllo', {
			type: 'text/plain',
		});
		expect(await text.text({ folder: 'a', name: 'b.txt' }, limit)).toBe(
			'héllo',
		);
		await bucket.delete(key, limit);
		expect(await bucket.exists(key)).toBe(false);
	});

	test('for an object that is not', async () => {
		const bucket = bindBucket(avatars, servers.s3.options);
		const limit = { timeoutMs: 5000 };
		expect(await bucket.stat(gone, limit)).toBeUndefined();
		expect(await bucket.exists(gone, limit)).toBe(false);
		expect(await bucket.bytes(gone, limit)).toBeUndefined();
		expect(await bucket.text(gone, limit)).toBeUndefined();
		await bucket.delete(gone, limit);
	});

	test('and a service failure comes back as Bun’s own kind of error', async () => {
		const bucket = bindBucket(avatars, {
			...servers.s3.options,
			secretAccessKey: 'wrong-secret',
		});
		const limit = { timeoutMs: 5000 };
		for (const call of [
			() => bucket.bytes(key, limit),
			() => bucket.delete(key, limit),
		]) {
			const error = (await rejection(call())) as Error & { code?: string };
			expect(error.name).toBe('S3Error');
			expect(error).not.toBeInstanceOf(S3Error);
			expect(error.code).toBe('SignatureDoesNotMatch');
		}
		const head = (await rejection(bucket.stat(key, limit))) as Error & {
			code?: string;
		};
		expect(head.code).toBe('UnknownError');
		expect(head.message).not.toContain('wrong-secret');
	});
});

describe('no answer in time', () => {
	test('stat rejects with TIMEOUT and aborts the request', async () => {
		const { state, options } = silentEndpoint();
		const bucket = bindBucket(avatars, options);
		const started = performance.now();
		const error = await rejection(bucket.stat(key, { timeoutMs: 200 }));
		const took = performance.now() - started;
		expect(error).toBeInstanceOf(S3Error);
		expect((error as S3Error).code).toBe('TIMEOUT');
		expect((error as S3Error).key).toBe('u1.png');
		expect((error as S3Error).message).toBe(
			'stat on "avatars": no answer in 200ms',
		);
		expect(took).toBeGreaterThanOrEqual(190);
		expect(took).toBeLessThan(1000);
		await settle();
		expect(state.closed).toBeGreaterThanOrEqual(1);
	});

	test('so do the GET and the DELETE based calls', async () => {
		const { state, options } = silentEndpoint();
		const bucket = bindBucket(avatars, options);
		const limit = { timeoutMs: 150 };
		expect(await rejectionMessage(bucket.bytes(key, limit))).toBe(
			'bytes on "avatars": no answer in 150ms',
		);
		expect(await rejectionMessage(bucket.text(key, limit))).toBe(
			'text on "avatars": no answer in 150ms',
		);
		expect(await rejectionMessage(bucket.exists(key, limit))).toBe(
			'exists on "avatars": no answer in 150ms',
		);
		expect(await rejectionMessage(bucket.delete(key, limit))).toBe(
			'delete on "avatars": no answer in 150ms',
		);
		await settle();
		expect(state.closed).toBeGreaterThanOrEqual(4);
	});

	test('the bucket’s default applies, and a call’s own wins', async () => {
		const { options } = silentEndpoint();
		const bucket = bindBucket(avatars, { ...options, timeoutMs: 150 });
		expect(await rejectionMessage(bucket.stat(key))).toBe(
			'stat on "avatars": no answer in 150ms',
		);
		expect(await rejectionMessage(bucket.stat(key, { timeoutMs: 250 }))).toBe(
			'stat on "avatars": no answer in 250ms',
		);
	});

	test('the default does not reach the client', async () => {
		const bucket = bindBucket(avatars, {
			...servers.s3.options,
			timeoutMs: 5000,
		});
		await bucket.put(key, png, { type: 'image/png' });
		expect(await bucket.bytes(key)).toEqual(png);
	});
});

describe('a timeoutMs that is not a whole number of milliseconds', () => {
	const bad = [0, -1, 1.5, '200', null, Number.NaN] as const;

	test('is refused on the call, before anything is sent', async () => {
		const { state, options } = silentEndpoint();
		const bucket = bindBucket(avatars, options);
		for (const value of bad) {
			const error = await rejection(
				bucket.stat(key, { timeoutMs: value as unknown as number }),
			);
			expect(error).toBeInstanceOf(S3Error);
			expect((error as S3Error).code).toBe('WRONG_OPTION');
			expect((error as S3Error).message).toStartWith(
				'timeoutMs is a whole number of milliseconds, 1 or more; got ',
			);
			expect((error as S3Error).message).toEndWith(' (stat on "avatars")');
		}
		await settle();
		expect(state.closed).toBe(0);
	});

	test('is refused on bindBucket', () => {
		for (const value of bad) {
			expect(() =>
				bindBucket(avatars, { timeoutMs: value as unknown as number }),
			).toThrow(S3Error);
		}
	});
});

describe('around the deadline', () => {
	test('a key function that throws rejects, on all five calls', async () => {
		const broken = defineBucket({
			bucket: 'broken',
			key: (_: string): string => {
				throw new Error('no key');
			},
		});
		const bucket = bindBucket(broken, silentEndpoint().options);
		for (const call of [
			() => bucket.stat('x'),
			() => bucket.exists('x'),
			() => bucket.bytes('x'),
			() => bucket.text('x'),
			() => bucket.delete('x'),
		]) {
			expect(await rejectionMessage(call())).toBe('no key');
		}
	});

	test('a refused connection says so without the signed URL', async () => {
		const bucket = bindBucket(avatars, {
			endpoint: 'http://127.0.0.1:1',
			accessKeyId: 'k',
			secretAccessKey: 's',
			virtualHostedStyle: false,
			retry: 0,
		});
		for (const [call, method] of [
			[() => bucket.stat(key, { timeoutMs: 2000 }), 'HEAD'],
			[() => bucket.bytes(key, { timeoutMs: 2000 }), 'GET'],
			[() => bucket.delete(key, { timeoutMs: 2000 }), 'DELETE'],
		] as const) {
			const message = await rejectionMessage(call());
			// Bun 1.4.2 (the pinned one CI runs) names it ConnectionRefused, 1.4.3
			// ECONNREFUSED: the code passes through as the runtime gives it.
			expect(message).toMatch(
				new RegExp(`^${method} failed: (ECONNREFUSED|ConnectionRefused)$`),
			);
			expect(message).not.toContain('X-Amz-Signature');
			expect(message).not.toContain('127.0.0.1:');
		}
	});

	test('the bucket default applies to every call that takes one', async () => {
		const { options } = silentEndpoint();
		const bucket = bindBucket(avatars, { ...options, timeoutMs: 150 });
		for (const [name, call] of [
			['exists', () => bucket.exists(key)],
			['bytes', () => bucket.bytes(key)],
			['text', () => bucket.text(key)],
			['delete', () => bucket.delete(key)],
		] as const) {
			expect(await rejectionMessage(call())).toBe(
				`${name} on "avatars": no answer in 150ms`,
			);
		}
	});

	test('a 404 that is not NoSuchKey throws, as on the Bun path', async () => {
		const listener = Bun.listen({
			hostname: '127.0.0.1',
			port: 0,
			socket: {
				data(socket) {
					socket.write(
						'HTTP/1.1 404 Not Found\r\ncontent-type: application/xml\r\ncontent-length: 80\r\nconnection: close\r\n\r\n' +
							'<Error><Code>NoSuchBucket</Code><Message>gone</Message></Error>'.padEnd(
								80,
							),
					);
					socket.end();
				},
			},
		});
		listeners.push(listener);
		const missing = bindBucket(avatars, {
			...servers.s3.options,
			endpoint: `http://127.0.0.1:${listener.port}`,
		});
		const error = (await rejection(
			missing.bytes(key, { timeoutMs: 2000 }),
		)) as {
			code?: string;
		};
		expect(error.code).toBe('NoSuchBucket');
	});

	test('a stall while the body is read is a TIMEOUT too', async () => {
		const state = { closed: 0 };
		const listener = Bun.listen({
			hostname: '127.0.0.1',
			port: 0,
			socket: {
				data(socket) {
					socket.write('HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\npartial');
				},
				close() {
					state.closed++;
				},
			},
		});
		listeners.push(listener);
		const bucket = bindBucket(avatars, {
			...servers.s3.options,
			endpoint: `http://127.0.0.1:${listener.port}`,
			retry: 0,
		});
		expect(await rejectionMessage(bucket.bytes(key, { timeoutMs: 300 }))).toBe(
			'bytes on "avatars": no answer in 300ms',
		);
		await settle();
		expect(state.closed).toBeGreaterThanOrEqual(1);
	});
});

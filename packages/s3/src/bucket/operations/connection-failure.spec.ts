import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { avatars } from '../../../test/fixtures';
import { rejection } from '../../../test/rejection';
import { bindBucket } from '../bind-bucket';

const key = { userId: 'u1' };
const listeners: { stop(force?: boolean): void }[] = [];
afterEach(() => {
	for (const listener of listeners.splice(0)) listener.stop(true);
});

/** A server that promises 100 bytes, sends 3 and ends the socket. */
function resetMidBody(): number {
	const listener = Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		socket: {
			data(socket) {
				socket.write('HTTP/1.1 200 OK\r\ncontent-length: 100\r\n\r\nabc');
				setTimeout(() => socket.end(), 30);
			},
		},
	});
	listeners.push(listener);
	return listener.port;
}

/** A port nothing listens on. */
function closedPort(): number {
	const listener = Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		socket: { data() {} },
	});
	const { port } = listener;
	listener.stop(true);
	return port;
}

const bucketAt = (port: number, timeoutMs?: number) =>
	bindBucket(avatars, {
		endpoint: `http://127.0.0.1:${port}`,
		accessKeyId: 'k',
		secretAccessKey: 's',
		virtualHostedStyle: false,
		retry: 0,
		timeoutMs,
	});

const shape = (error: unknown) => {
	const { name, code, path } = error as {
		name: string;
		code: string;
		path: string;
	};
	return { name, code, path };
};

describe('a connection that fails, with or without a deadline', () => {
	for (const [what, port, code] of [
		['reset mid-body', resetMidBody, 'ConnectionClosed'],
		['refused', closedPort, 'ConnectionRefused'],
	] as const) {
		test(`${what}: the same name, code and path`, async () => {
			const at = port();
			const plain = await rejection(bucketAt(at).bytes(key));
			expect(shape(plain)).toEqual({ name: 'S3Error', code, path: 'u1.png' });
			const calls = [
				(b: ReturnType<typeof bucketAt>) => b.bytes(key),
				(b: ReturnType<typeof bucketAt>) => b.text(key),
				...(what === 'refused'
					? [
							(b: ReturnType<typeof bucketAt>) => b.stat(key),
							(b: ReturnType<typeof bucketAt>) => b.delete(key),
						]
					: []),
			];
			for (const call of calls) {
				const error = await rejection(call(bucketAt(at, 5000)));
				expect(shape(error)).toEqual(shape(plain));
				expect((error as Error).message).toBe((plain as Error).message);
				expect((error as Error).cause).toBeUndefined();
				const shown = Bun.inspect(error);
				expect(shown).not.toContain('X-Amz-Signature');
				expect(shown).not.toContain('127.0.0.1:');
			}
		});
	}
});

/** One answer, whatever the request, then the socket ends. */
function answering(respond: () => string): number {
	const listener = Bun.listen({
		hostname: '127.0.0.1',
		port: 0,
		socket: {
			data(socket) {
				socket.write(respond());
				socket.end();
			},
		},
	});
	listeners.push(listener);
	return listener.port;
}

const NO_BODY = 'content-length: 0\r\nconnection: close\r\n\r\n';

describe('an answer that is not S3’s, with or without a deadline', () => {
	test('a host that does not resolve is DNSResolveFailed on both', async () => {
		const at = (timeoutMs?: number) =>
			bindBucket(avatars, {
				endpoint: 'http://no-such-host.invalid',
				accessKeyId: 'k',
				secretAccessKey: 's',
				virtualHostedStyle: false,
				retry: 0,
				timeoutMs,
			});
		const plain = await rejection(at().bytes(key));
		expect(shape(plain).code).toBe('DNSResolveFailed');
		expect(shape(await rejection(at(5000).bytes(key)))).toEqual(shape(plain));
	});

	test('a 404 with no S3 body (a proxy’s) reads as missing, and a delete fails the same', async () => {
		const port = answering(() => `HTTP/1.1 404 Not Found\r\n${NO_BODY}`);
		const plain = bucketAt(port);
		const timed = bucketAt(port, 5000);
		expect(await plain.bytes(key)).toBeUndefined();
		expect(await timed.bytes(key)).toBeUndefined();
		expect(await timed.text(key)).toBeUndefined();
		expect(await timed.stat(key)).toBeUndefined();
		const own = await rejection(plain.delete(key));
		const deadline = await rejection(timed.delete(key));
		expect(shape(own).code).toBe('NoSuchKey');
		expect(shape(deadline)).toEqual(shape(own));
		expect((deadline as Error).message).toBe((own as Error).message);
		expect(Object.getOwnPropertyNames(deadline).sort()).toEqual(
			Object.getOwnPropertyNames(own).sort(),
		);
	});

	test('a redirect is followed on both paths', async () => {
		const target = answering(
			() =>
				'HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nhi',
		);
		const port = answering(
			() =>
				`HTTP/1.1 302 Found\r\nlocation: http://127.0.0.1:${target}/other\r\n${NO_BODY}`,
		);
		expect(await bucketAt(port).text(key)).toBe('hi');
		expect(await bucketAt(port, 5000).text(key)).toBe('hi');
	});
});

describe('a put and a list that fail under a deadline leak no credential', () => {
	/** Reads the request, answers nothing and ends the socket: a reset. */
	function resetting(): number {
		const listener = Bun.listen({
			hostname: '127.0.0.1',
			port: 0,
			socket: {
				data(socket) {
					socket.end();
				},
			},
		});
		listeners.push(listener);
		return listener.port;
	}

	for (const [what, port, code] of [
		['reset', resetting, 'ConnectionClosed'],
		['refused', closedPort, 'ConnectionRefused'],
	] as const) {
		test(`${what}: Bun’s name and code, and no signed URL anywhere`, async () => {
			const bucket = bucketAt(port(), 5000);
			const calls = [
				() => bucket.put(key, new Uint8Array(8), { type: 'image/png' }),
				() => bucket.list(),
			];
			for (const call of calls) {
				const spy = spyOn(globalThis, 'fetch');
				const error = (await rejection(call())) as Error;
				// The deadline's path is the one that failed, not Bun's own.
				expect(spy.mock.calls.length).toBe(1);
				spy.mockRestore();
				expect(shape(error).name).toBe('S3Error');
				expect(shape(error).code).toBe(code);
				expect(error.cause).toBeUndefined();
				const seen = [
					error.message,
					Bun.inspect(error),
					...Object.getOwnPropertyNames(error).map((name) =>
						String((error as unknown as Record<string, unknown>)[name]),
					),
				].join('\n');
				expect(seen).not.toContain('X-Amz-Signature');
				expect(seen).not.toContain('X-Amz-Credential');
				expect(seen).not.toContain('127.0.0.1:');
			}
		});
	}
});

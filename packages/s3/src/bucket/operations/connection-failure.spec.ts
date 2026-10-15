import { afterEach, describe, expect, test } from 'bun:test';
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

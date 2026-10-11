import { afterEach, describe, expect, test } from 'bun:test';
import { loginLimit, useClients, useRedis } from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { GuardError } from '../errors/guard-error';
import { bindRateLimit } from './bind-rate-limit';

// `timeoutMs` on `consume`, `enforce` and `peek`. A Redis that does not
// answer is made with `CLIENT PAUSE … WRITE` from a second client: the
// rate-limit script is not flagged read-only, so the server holds it, `peek`
// included, until the pause ends — and then runs it.

const servers = useRedis();
const clients = useClients(servers);
const ip = { ip: '203.0.113.7' };

// A script a test gave up on runs once the pause ends. Each client's
// commands run in order, so a `PING` behind it answers only once it ran:
// nothing a test left behind lands after the next test's `FLUSHALL`.
afterEach(async () => {
	const [a, b] = clients();
	await b.send('CLIENT', ['UNPAUSE']);
	await a.ping();
});

/** Holds every write on the server for `ms`, from the second client. */
async function pause(ms: number): Promise<void> {
	const [, b] = clients();
	await b.send('CLIENT', ['PAUSE', String(ms), 'WRITE']);
}

describe('a call Redis does not answer in time', () => {
	test('consume rejects with TIMEOUT, naming the definition and never the key', async () => {
		const [a] = clients();
		const login = bindRateLimit(a, loginLimit);
		await pause(400);
		const startedAt = performance.now();
		const error = await rejection(login.consume(ip, 1, { timeoutMs: 50 }));
		expect(performance.now() - startedAt).toBeLessThan(300);
		expect(error).toBeInstanceOf(GuardError);
		const guard = error as GuardError;
		expect(guard.code).toBe('TIMEOUT');
		expect(guard.definition).toBe('login');
		expect(guard.retryAfter).toBeUndefined();
		expect(guard.message).toBe(
			'consume on "login": Redis did not answer within 50ms; ' +
				'the script may still run, and count this cost',
		);
		expect(guard.message).not.toContain('203.0.113.7');
	});

	test('the cost may still be counted once the server runs the script', async () => {
		const [a] = clients();
		const login = bindRateLimit(a, loginLimit);
		await pause(200);
		const error = await rejection(login.consume(ip, 2, { timeoutMs: 20 }));
		expect((error as GuardError).code).toBe('TIMEOUT');
		await Bun.sleep(300);
		expect((await login.peek(ip, 0)).remaining).toBe(3);
	});

	test('enforce and peek time out the same way', async () => {
		const [a] = clients();
		const login = bindRateLimit(a, loginLimit);
		await pause(400);
		const enforced = await rejection(
			login.enforce(ip, undefined, { timeoutMs: 30 }),
		);
		const peeked = await rejection(login.peek(ip, 0, { timeoutMs: 30 }));
		expect((enforced as GuardError).code).toBe('TIMEOUT');
		expect((enforced as GuardError).message).toStartWith('enforce on "login"');
		expect((peeked as GuardError).code).toBe('TIMEOUT');
		expect((peeked as GuardError).message).toBe(
			'peek on "login": Redis did not answer within 30ms; nothing was counted',
		);
	});

	test('a server that answers in time gives the result as without one', async () => {
		const login = bindRateLimit(servers.redis.client, loginLimit);
		const result = await login.consume(ip, 1, { timeoutMs: 1_000 });
		expect(result).toMatchObject({ allowed: true, remaining: 4 });
		const denied = await login.enforce(ip, 4, { timeoutMs: 1_000 });
		expect(denied.remaining).toBe(0);
		const spent = await rejection(login.enforce(ip, 1, { timeoutMs: 1_000 }));
		expect((spent as GuardError).code).toBe('RATE_LIMITED');
		expect((await login.peek(ip, 1, { timeoutMs: 1_000 })).allowed).toBe(false);
	});

	test('timeoutMs left out, or undefined, waits as long as the client does', async () => {
		const [a] = clients();
		const login = bindRateLimit(a, loginLimit);
		await pause(150);
		const result = await login.consume(ip, 1, { timeoutMs: undefined });
		expect(result.allowed).toBe(true);
	});
});

describe('a timeoutMs that is not a whole number of 1 or more', () => {
	test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '50'])(
		'%p is a TypeError, and nothing is sent',
		async (timeoutMs) => {
			const login = bindRateLimit(servers.redis.client, loginLimit);
			const options = { timeoutMs } as unknown as { timeoutMs: number };
			for (const call of [
				login.consume(ip, 1, options),
				login.enforce(ip, 1, options),
				login.peek(ip, 1, options),
			]) {
				const error = await rejection(call);
				expect(error).toBeInstanceOf(TypeError);
				expect((error as Error).message).toMatch(
					/^(consume|enforce|peek) on "login": timeoutMs is a whole number of milliseconds, 1 or more$/,
				);
			}
			expect((await login.peek(ip, 0)).remaining).toBe(5);
		},
	);
});

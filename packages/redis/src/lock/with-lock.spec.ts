import { describe, expect, test } from 'bun:test';
import { useRedis } from '../../test/fixtures';
import { RedisError } from '../errors/redis-error';
import { withLock } from './with-lock';

const servers = useRedis();

describe('withLock', () => {
	test('runs the work and gives back what it returns', async () => {
		const answer = await withLock(servers.redis.client, 'job', () => 42);
		expect(answer).toBe(42);
		// The lock is gone, so the next run takes it.
		expect(await servers.redis.client.get('lock:job')).toBeNull();
	});

	test('keeps a second run out while the first holds it', async () => {
		let inside = false;
		let overlapped = false;
		const run = () =>
			withLock(
				servers.redis.client,
				'job',
				async () => {
					if (inside) overlapped = true;
					inside = true;
					await Bun.sleep(80);
					inside = false;
				},
				{ wait: 2_000 },
			);
		await Promise.all([run(), run(), run()]);
		expect(overlapped).toBe(false);
	});

	test('refuses at once when nobody waits', async () => {
		await withLock(
			servers.redis.client,
			'job',
			async () => {
				await expect(
					withLock(servers.redis.client, 'job', () => 'never'),
				).rejects.toThrow(RedisError);
			},
			{ ttl: 5_000 },
		);
	});

	test('the refusal says which lock, and carries LOCK_HELD', async () => {
		await servers.redis.client.set('lock:taken', 'someone-else');
		const error = (await withLock(servers.redis.client, 'taken', () => 1).catch(
			(reason: unknown) => reason,
		)) as RedisError;
		expect(error).toBeInstanceOf(RedisError);
		expect(error.code).toBe('LOCK_HELD');
		expect(error.key).toBe('lock:taken');
		expect(error.message).toContain('"taken"');
	});

	test('gives the lock back when the work throws, and passes the error on', async () => {
		await expect(
			withLock(servers.redis.client, 'job', () => {
				throw new Error('work failed');
			}),
		).rejects.toThrow('work failed');
		expect(await servers.redis.client.get('lock:job')).toBeNull();
	});

	test('the lock expires on its own, so a dead holder frees it', async () => {
		await withLock(
			servers.redis.client,
			'job',
			async () => {
				const ttl = await servers.redis.client.send('PTTL', ['lock:job']);
				expect(Number(ttl)).toBeGreaterThan(0);
				expect(Number(ttl)).toBeLessThanOrEqual(200);
			},
			{ ttl: 200 },
		);
	});

	test('says LOCK_LOST when the work outlived its ttl', async () => {
		const error = (await withLock(
			servers.redis.client,
			'slow',
			async () => {
				await Bun.sleep(150);
				return 'done';
			},
			{ ttl: 50 },
		).catch((reason: unknown) => reason)) as RedisError;
		expect(error).toBeInstanceOf(RedisError);
		expect(error.code).toBe('LOCK_LOST');
		expect(error.message).toContain('50ms ttl');
	});

	test('a run that overran never frees the lock somebody else has taken', async () => {
		// The slow run's lock expires; another holder takes the key. Releasing
		// by `DEL` would free theirs — the release script compares first.
		const slow = withLock(
			servers.redis.client,
			'slow',
			async () => {
				await Bun.sleep(150);
			},
			{ ttl: 50 },
		).catch((reason: unknown) => reason);

		await Bun.sleep(80);
		await servers.redis.client.set('lock:slow', 'the-next-holder');

		expect(((await slow) as RedisError).code).toBe('LOCK_LOST');
		expect(await servers.redis.client.get('lock:slow')).toBe('the-next-holder');
	});

	test('a nested lock losing its own does not keep the outer one', async () => {
		// The inner call throws LOCK_LOST. Were the outer one to recognise its
		// own loss by the error's shape rather than by what it did itself, it
		// would take that for its own, skip its release, and hold `lock:outer`
		// for the rest of its 10 s ttl.
		const error = (await withLock(
			servers.redis.client,
			'outer',
			async () => {
				await withLock(
					servers.redis.client,
					'inner',
					async () => {
						await Bun.sleep(150);
					},
					{ ttl: 40 },
				);
			},
			{ ttl: 10_000 },
		).catch((reason: unknown) => reason)) as RedisError;

		expect(error.code).toBe('LOCK_LOST');
		expect(error.key).toBe('lock:inner');
		expect(await servers.redis.client.get('lock:outer')).toBeNull();
	});

	test('says how to wait when nobody did', async () => {
		await servers.redis.client.set('lock:taken', 'someone-else');
		const error = (await withLock(servers.redis.client, 'taken', () => 1).catch(
			(reason: unknown) => reason,
		)) as RedisError;
		// `0ms was not long enough` reads like a bug report; it is not one.
		expect(error.message).toContain('did not wait for it');
		expect(error.message).toContain('`wait`');
	});

	test('waits for a lock that is given back inside the wait', async () => {
		const held = withLock(
			servers.redis.client,
			'job',
			async () => {
				await Bun.sleep(100);
			},
			{ ttl: 5_000 },
		);
		await Bun.sleep(10);
		const waited = await withLock(servers.redis.client, 'job', () => 'got it', {
			wait: 3_000,
			retryDelay: 20,
		});
		expect(waited).toBe('got it');
		await held;
	});
});

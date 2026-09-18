import { describe, expect, test } from 'bun:test';
import { useRedis } from '../../test/fixtures';
import { closeRedis, connectRedis } from './connect';

const servers = useRedis();

describe('connectRedis', () => {
	test('shares one client per URI, and closes it with the last holder', async () => {
		const first = await connectRedis(servers.redis.uri);
		const second = await connectRedis(servers.redis.uri);
		expect(second.client).toBe(first.client);

		await first.close();
		// One holder left, so the client is still usable.
		await second.client.set('still', 'here');
		expect(await second.client.get('still')).toBe('here');

		await second.close();
		expect(second.client.connected).toBe(false);
	});

	test('connects once even when the calls race', async () => {
		const [a, b, c] = await Promise.all([
			connectRedis(servers.redis.uri),
			connectRedis(servers.redis.uri),
			connectRedis(servers.redis.uri),
		]);
		expect(b.client).toBe(a.client);
		expect(c.client).toBe(a.client);
		await Promise.all([a.close(), b.close(), c.close()]);
	});

	test('closing twice is closing once', async () => {
		const one = await connectRedis(servers.redis.uri);
		const two = await connectRedis(servers.redis.uri);
		// Were `close` not idempotent, this would drop two holders and take
		// the client away from the one that is left.
		await one.close();
		await one.close();
		await two.client.set('kept', 'yes');
		expect(await two.client.get('kept')).toBe('yes');
		await two.close();
	});

	test('refuses the same URI with other options', async () => {
		const one = await connectRedis(servers.redis.uri, { maxRetries: 3 });
		try {
			await expect(
				connectRedis(servers.redis.uri, { maxRetries: 9 }),
			).rejects.toThrow('already connected with other options');
			// The same options, built again, are the same options.
			const again = await connectRedis(servers.redis.uri, { maxRetries: 3 });
			expect(again.client).toBe(one.client);
			await again.close();
		} finally {
			await one.close();
		}
	});

	test('a URI is never in the refusal: it may carry a password', async () => {
		const one = await connectRedis(servers.redis.uri, { maxRetries: 3 });
		try {
			const error = await connectRedis(servers.redis.uri, {
				maxRetries: 9,
			}).catch((reason: Error) => reason);
			expect((error as Error).message).not.toContain(servers.redis.uri);
		} finally {
			await one.close();
		}
	});

	test('ping reports, and does not throw', async () => {
		await using redis = await connectRedis(servers.redis.uri);
		const answer = await redis.ping();
		expect(answer.ok).toBe(true);
		if (answer.ok) expect(answer.latencyMs).toBeGreaterThanOrEqual(0);
	});

	test('a failed connect is forgotten, so the next call tries again', async () => {
		// Nothing listens on this port. `autoReconnect: false` is what makes
		// that quick: measured, `connectionTimeout` does not bound a refused
		// connection, and the default retries for about 31 seconds first.
		const dead = 'redis://127.0.0.1:1';
		const options = { autoReconnect: false };
		await expect(connectRedis(dead, options)).rejects.toThrow();
		// Were it remembered, this would resolve to the broken one instead of
		// trying again — and the error would be the *first* call's.
		await expect(connectRedis(dead, options)).rejects.toThrow();
	});

	test('closeRedis takes every client, whoever holds one', async () => {
		const held = await connectRedis(servers.redis.uri);
		await closeRedis();
		expect(held.client.connected).toBe(false);
		// The holder's own close then has nothing left to do.
		await expect(held.close()).resolves.toBeUndefined();
	});

	test('a connect closeRedis interrupts fails rather than hand a closed client', async () => {
		const connecting = connectRedis(servers.redis.uri);
		await closeRedis();
		await expect(connecting).rejects.toThrow(
			'closed while this one was connecting',
		);
	});

	test('a close after closeRedis does not take the next client away', async () => {
		const stale = await connectRedis(servers.redis.uri);
		await closeRedis();
		// A fresh holder, on a client of its own.
		const fresh = await connectRedis(servers.redis.uri);
		expect(fresh.client).not.toBe(stale.client);
		// The stale holder's close must not touch the client it no longer owns.
		await stale.close();
		await fresh.client.set('kept', 'yes');
		expect(await fresh.client.get('kept')).toBe('yes');
		await fresh.close();
	});

	test('the options are kept as given, so mutating them refuses nothing', async () => {
		const options = { maxRetries: 3 };
		const one = await connectRedis(servers.redis.uri, options);
		try {
			// A retry-policy tweak somewhere else, on the same object.
			options.maxRetries = 9;
			// The call still asks for what the first one asked for, so it shares.
			const again = await connectRedis(servers.redis.uri, { maxRetries: 3 });
			expect(again.client).toBe(one.client);
			await again.close();
		} finally {
			await one.close();
		}
	});

	test('await using closes it', async () => {
		let client: { connected: boolean };
		{
			await using redis = await connectRedis(servers.redis.uri);
			client = redis.client;
			expect(client.connected).toBe(true);
		}
		expect(client.connected).toBe(false);
	});
});

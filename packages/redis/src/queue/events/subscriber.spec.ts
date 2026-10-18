import { describe, expect, test } from 'bun:test';
import type { RedisClient } from 'bun';
import { eventually, gate, useRedis } from '../../../test/fixtures';
import { listen } from './subscriber';

const servers = useRedis();
const client = () => servers.redis.client;

async function connections() {
	const list = (await client().send('CLIENT', ['LIST'])) as string;
	return list.split('\n').filter((line) => line.trim() !== '').length;
}

describe('the shared subscriber', () => {
	test('two queues on one client share one connection', async () => {
		const before = await connections();
		const a = await listen(client(), 'queue:{a}:events', () => {});
		const b = await listen(client(), 'queue:{b}:events', () => {});
		expect(await connections()).toBe(before + 1);
		await a();
		await b();
	});

	test('a message reaches every listener of its channel and no other', async () => {
		const first: string[] = [];
		const second: string[] = [];
		const other: string[] = [];
		const offs = [
			await listen(client(), 'queue:{a}:events', (m) => first.push(m)),
			await listen(client(), 'queue:{a}:events', (m) => second.push(m)),
			await listen(client(), 'queue:{b}:events', (m) => other.push(m)),
		];
		// Heard right after the await: the SUBSCRIBE was confirmed.
		await client().publish('queue:{a}:events', 'hello');
		await eventually(() => [first, second], [['hello'], ['hello']]);
		expect(other).toEqual([]);
		await offs[0]?.();
		await client().publish('queue:{a}:events', 'again');
		await eventually(() => second, ['hello', 'again']);
		expect(first).toEqual(['hello']);
		for (const off of offs) await off();
	});

	test('the last unlisten closes the connection', async () => {
		const before = await connections();
		const a = await listen(client(), 'queue:{a}:events', () => {});
		const b = await listen(client(), 'queue:{b}:events', () => {});
		await a();
		expect(await connections()).toBe(before + 1);
		await b();
		await eventually(connections, before);
	});

	test('unlisten twice is a no-op', async () => {
		const got: string[] = [];
		const keep = await listen(client(), 'queue:{a}:events', (m) => got.push(m));
		const off = await listen(client(), 'queue:{a}:events', () => {});
		await off();
		await off();
		await client().publish('queue:{a}:events', 'x');
		await eventually(() => got, ['x']);
		await keep();
		await keep();
	});

	test('concurrent first listens open one connection', async () => {
		const before = await connections();
		const offs = await Promise.all(
			Array.from({ length: 5 }, (_, i) =>
				listen(client(), `queue:{c${i % 2}}:events`, () => {}),
			),
		);
		expect(await connections()).toBe(before + 1);
		for (const off of offs) await off();
	});

	test('a second listen on a channel waits for the live subscription', async () => {
		const got: string[] = [];
		const [, off] = await Promise.all([
			listen(client(), 'queue:{a}:events', () => {}),
			listen(client(), 'queue:{a}:events', (m) => got.push(m)),
		]);
		await client().publish('queue:{a}:events', 'now');
		await eventually(() => got, ['now']);
		await off();
	});

	test('a listen racing the last unlisten keeps a live connection', async () => {
		const got: string[] = [];
		const first = await listen(client(), 'queue:{a}:events', () => {});
		const closing = first();
		const second = await listen(client(), 'queue:{a}:events', (m) =>
			got.push(m),
		);
		await closing;
		await client().publish('queue:{a}:events', 'alive');
		await eventually(() => got, ['alive']);
		await second();
	});

	test('a throwing listener does not stop the others', async () => {
		const got: string[] = [];
		const offs = [
			await listen(client(), 'queue:{a}:events', () => {
				throw new Error('boom');
			}),
			await listen(client(), 'queue:{a}:events', (m) => got.push(m)),
		];
		await client().publish('queue:{a}:events', '1');
		await client().publish('queue:{a}:events', '2');
		await eventually(() => got, ['1', '2']);
		for (const off of offs) await off();
	});

	test('concurrent last unlistens on two channels both resolve and close the connection', async () => {
		const before = await connections();
		const a = await listen(client(), 'queue:{a}:events', () => {});
		const b = await listen(client(), 'queue:{b}:events', () => {});
		const settled = await Promise.allSettled([a(), b()]);
		expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']);
		await eventually(connections, before);
	});

	test('a failed open is followed by a successful retry', async () => {
		let calls = 0;
		const flaky = {
			duplicate: async () => {
				calls += 1;
				if (calls === 1) throw new Error('refused');
				return await client().duplicate();
			},
		} as unknown as RedisClient;
		await expect(listen(flaky, 'queue:{a}:events', () => {})).rejects.toThrow(
			'refused',
		);
		const got: string[] = [];
		const off = await listen(flaky, 'queue:{a}:events', (m) => got.push(m));
		await client().publish('queue:{a}:events', 'ok');
		await eventually(() => got, ['ok']);
		await off();
	});

	test('a listener may unlisten itself inside its callback', async () => {
		const got: string[] = [];
		let off: () => Promise<void> = async () => {};
		off = await listen(client(), 'queue:{a}:events', (m) => {
			got.push(m);
			void off();
		});
		await client().publish('queue:{a}:events', '1');
		await eventually(() => got, ['1']);
		await off();
	});

	test('a rejected SUBSCRIBE rejects listen and leaves no entry', async () => {
		let subscribes = 0;
		const stub = {
			duplicate: async () => ({
				connect: async () => {},
				subscribe: async () => {
					subscribes += 1;
					if (subscribes === 1) throw new Error('denied');
				},
				unsubscribe: async () => {},
				close: () => {},
			}),
		} as unknown as RedisClient;
		await expect(listen(stub, 'queue:{a}:events', () => {})).rejects.toThrow(
			'denied',
		);
		const off = await listen(stub, 'queue:{a}:events', () => {});
		expect(subscribes).toBe(2);
		await off();
	});

	test('a close does not cut an UNSUBSCRIBE still pending on another channel', async () => {
		const release = gate();
		const slowed = {
			duplicate: async () => {
				const real = await client().duplicate();
				return {
					connect: () => real.connect(),
					subscribe: (channel: string, fn: (message: string) => void) =>
						real.subscribe(channel, fn),
					unsubscribe: async (channel: string) => {
						await release.opened;
						return await real.unsubscribe(channel);
					},
					close: () => real.close(),
				};
			},
		} as unknown as RedisClient;
		const a = await listen(slowed, 'queue:{a}:events', () => {});
		const b = await listen(slowed, 'queue:{b}:events', () => {});
		const first = a();
		const second = b();
		await Bun.sleep(20);
		release.open();
		const settled = await Promise.allSettled([first, second]);
		expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'fulfilled']);
	});
});

import { describe, expect, test } from 'bun:test';
import { eventually, useRedis } from '../../../test/fixtures';
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
});

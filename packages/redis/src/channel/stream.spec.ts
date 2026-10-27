import { describe, expect, test } from 'bun:test';
import { rejection } from '../../test/rejection';
import { createKeyedStreams, type StreamSource } from './stream';

type Change = { roomId: string; n: number };

/** A broker in memory: what Redis does for `subscribe` and `publish`. */
function fakeBroker() {
	const handlers = new Set<(message: Change) => void>();
	const state = {
		down: false,
		subscribes: 0,
		closes: 0,
		failNextSubscribe: false,
	};
	const source: StreamSource<Change> = {
		parse(message) {
			if (message.n < 0) throw new Error('INVALID');
			return { ...message, n: message.n * 10 }; // a transform
		},
		refuses: (error) => error instanceof Error && error.message === 'INVALID',
		async publish(message) {
			if (message.n < 0) throw new Error('INVALID');
			if (state.down) throw new Error('ECONNREFUSED');
			for (const handler of handlers) handler(message);
			return handlers.size;
		},
		async subscribe(handler) {
			if (state.down || state.failNextSubscribe) {
				state.failNextSubscribe = false;
				throw new Error('ECONNREFUSED');
			}
			state.subscribes += 1;
			handlers.add(handler);
			return {
				async close() {
					state.closes += 1;
					handlers.delete(handler);
				},
			};
		},
	};
	return { source, state, listeners: () => handlers.size };
}

const room = (roomId: string, n = 0): Change => ({ roomId, n });
const keyOf = (message: Change) => message.roomId;

describe('keyed streams', () => {
	test('two keys fan out to their own iterators only', async () => {
		const broker = fakeBroker();
		const streams = createKeyedStreams(broker.source, keyOf);
		const a = streams.stream('a');
		const b = streams.stream('b');
		const first = a.next();
		const second = b.next();
		await Promise.resolve();
		await streams.publish(room('b', 2));
		await streams.publish(room('a', 1));
		expect(await first).toEqual({ value: room('a', 1), done: false });
		expect(await second).toEqual({ value: room('b', 2), done: false });
		await streams.close();
	});

	test('one subscription per process, opened by the first read', async () => {
		const broker = fakeBroker();
		const streams = createKeyedStreams(broker.source, keyOf);
		const a = streams.stream('a');
		const b = streams.stream('b');
		expect(broker.state.subscribes).toBe(0);
		const pending = [a.next(), b.next()];
		await streams.publish(room('a'));
		await streams.publish(room('b'));
		await Promise.all(pending);
		expect(broker.state.subscribes).toBe(1);
		await streams.close();
	});

	test('two iterators on one key both get the message', async () => {
		const broker = fakeBroker();
		const streams = createKeyedStreams(broker.source, keyOf);
		const one = streams.stream('a');
		const two = streams.stream('a');
		const reads = [one.next(), two.next()];
		await streams.publish(room('a', 7));
		expect((await Promise.all(reads)).map((r) => r.value)).toEqual([
			room('a', 7),
			room('a', 7),
		]);
		await streams.close();
	});

	test('return() while idle ends the pending read and leaves no listener', async () => {
		const broker = fakeBroker();
		const streams = createKeyedStreams(broker.source, keyOf);
		const it = streams.stream('a');
		const pending = it.next();
		await Promise.resolve();
		await Bun.sleep(5);
		expect(streams.listeners).toBe(1);
		// No message is ever published: both must settle on their own.
		expect(await it.return(undefined)).toEqual({
			value: undefined,
			done: true,
		});
		expect(await pending).toEqual({ value: undefined, done: true });
		expect(streams.listeners).toBe(0);
		expect(broker.state.closes).toBe(1);
		expect(broker.listeners()).toBe(0);
	});

	test('the last listener closes the shared subscription, the next one reopens it', async () => {
		const broker = fakeBroker();
		const streams = createKeyedStreams(broker.source, keyOf);
		const one = streams.stream('a');
		const two = streams.stream('b');
		void one.next();
		void two.next();
		await Bun.sleep(5);
		await one.return(undefined);
		expect(broker.state.closes).toBe(0);
		await two.return(undefined);
		expect(broker.state.closes).toBe(1);
		const again = streams.stream('a');
		const read = again.next();
		await Bun.sleep(5);
		await streams.publish(room('a', 3));
		expect((await read).value).toEqual(room('a', 3));
		expect(broker.state.subscribes).toBe(2);
		await streams.close();
	});

	test('Symbol.asyncDispose releases the listener, even while idle', async () => {
		const broker = fakeBroker();
		const streams = createKeyedStreams(broker.source, keyOf);
		{
			await using it = streams.stream('a');
			void it.next();
			await Bun.sleep(5);
			expect(streams.listeners).toBe(1);
		}
		expect(streams.listeners).toBe(0);
	});

	test('throw() releases the listener and rethrows', async () => {
		const broker = fakeBroker();
		const streams = createKeyedStreams(broker.source, keyOf);
		const it = streams.stream('a');
		void it.next();
		await Bun.sleep(5);
		expect(await rejection(it.throw(new Error('boom')))).toEqual(
			new Error('boom'),
		);
		expect(streams.listeners).toBe(0);
	});

	test('a for await loop ends when the consumer breaks', async () => {
		const broker = fakeBroker();
		const streams = createKeyedStreams(broker.source, keyOf);
		const seen: Change[] = [];
		const loop = (async () => {
			for await (const change of streams.stream('a')) {
				seen.push(change);
				break;
			}
		})();
		await Bun.sleep(5);
		await streams.publish(room('a', 1));
		await loop;
		expect(seen).toEqual([room('a', 1)]);
		expect(streams.listeners).toBe(0);
	});

	test('falls back to this process when Redis is down, with the parsed message', async () => {
		const broker = fakeBroker();
		const streams = createKeyedStreams(broker.source, keyOf, {
			fallback: true,
		});
		broker.state.down = true;
		const it = streams.stream('a');
		const read = it.next(); // the subscribe fails: the iterator is not refused
		await Bun.sleep(5);
		expect(await streams.publish(room('a', 4))).toBe(0); // does not throw
		expect(await read).toEqual({ value: room('a', 40), done: false });
		await streams.close();
	});

	test('a failed subscribe is forgotten and retried by the next iterator', async () => {
		const broker = fakeBroker();
		const streams = createKeyedStreams(broker.source, keyOf);
		broker.state.failNextSubscribe = true;
		const first = streams.stream('a');
		void first.next();
		await Bun.sleep(5);
		expect(broker.state.subscribes).toBe(0);
		const second = streams.stream('a');
		const read = second.next();
		await Bun.sleep(5);
		expect(broker.state.subscribes).toBe(1);
		await streams.publish(room('a', 5));
		expect((await read).value).toEqual(room('a', 5));
		await streams.close();
	});

	test('a publish that fails with nobody listening to its key still throws', async () => {
		const broker = fakeBroker();
		const streams = createKeyedStreams(broker.source, keyOf, {
			fallback: true,
		});
		const it = streams.stream('b');
		void it.next();
		await Bun.sleep(5);
		broker.state.down = true;
		const error = await rejection(streams.publish(room('a')));
		expect((error as Error).message).toBe('ECONNREFUSED');
		await streams.close();
	});

	test('without the fallback option a failed publish throws, listeners or not', async () => {
		const broker = fakeBroker();
		const streams = createKeyedStreams(broker.source, keyOf);
		const it = streams.stream('a');
		void it.next();
		await Bun.sleep(5);
		broker.state.down = true;
		const error = await rejection(streams.publish(room('a')));
		expect((error as Error).message).toBe('ECONNREFUSED');
		await streams.close();
	});

	test('an invalid message throws even with the fallback and a listener', async () => {
		const broker = fakeBroker();
		const streams = createKeyedStreams(broker.source, keyOf, {
			fallback: true,
		});
		const it = streams.stream('a');
		void it.next();
		await Bun.sleep(5);
		broker.state.down = true;
		const error = await rejection(streams.publish(room('a', -1)));
		expect((error as Error).message).toBe('INVALID');
		await streams.close();
	});

	test('bufferSize must be a whole number of at least 1', () => {
		const streams = createKeyedStreams(fakeBroker().source, keyOf);
		for (const bufferSize of [0, -1, 1.5, Number.NaN]) {
			expect(() => streams.stream('a', { bufferSize })).toThrow(TypeError);
		}
	});

	test('an iterator returned before its first read holds nothing', async () => {
		const broker = fakeBroker();
		const streams = createKeyedStreams(broker.source, keyOf);
		const it = streams.stream('a');
		expect(streams.listeners).toBe(0);
		await it.return(undefined);
		expect(await it.next()).toEqual({ value: undefined, done: true });
		expect(broker.state.subscribes).toBe(0);
	});

	test('a slow reader loses its oldest messages past the buffer size', async () => {
		const broker = fakeBroker();
		const streams = createKeyedStreams(broker.source, keyOf);
		const it = streams.stream('a', { bufferSize: 2 });
		const first = it.next();
		await Bun.sleep(5);
		for (const n of [1, 2, 3, 4]) await streams.publish(room('a', n));
		expect((await first).value).toEqual(room('a', 1));
		// 1 went to the waiting read; 2, 3 and 4 arrived after: 2 is dropped.
		expect((await it.next()).value).toEqual(room('a', 3));
		expect((await it.next()).value).toEqual(room('a', 4));
		await streams.close();
	});

	test('close() stops every iterator, idle or not, and closes the subscription', async () => {
		const broker = fakeBroker();
		const streams = createKeyedStreams(broker.source, keyOf);
		const one = streams.stream('a');
		const two = streams.stream('b');
		const reads = [one.next(), two.next()];
		await Bun.sleep(5);
		await streams.close();
		expect(await Promise.all(reads)).toEqual([
			{ value: undefined, done: true },
			{ value: undefined, done: true },
		]);
		expect(broker.state.closes).toBe(1);
		expect(streams.listeners).toBe(0);
		// A stream asked for after close() is already finished.
		expect(await streams.stream('a').next()).toEqual({
			value: undefined,
			done: true,
		});
	});

	test('an iterator made before close() and read after it is finished', async () => {
		const streams = createKeyedStreams(fakeBroker().source, keyOf);
		const it = streams.stream('a');
		await streams.close();
		expect(await it.next()).toEqual({ value: undefined, done: true });
		expect(streams.listeners).toBe(0);
	});

	describe('a subscribe that hangs', () => {
		/** A broker whose subscribe stays pending until `settle` is called. */
		function hangingBroker() {
			const broker = fakeBroker();
			const settlers: ((fail: boolean) => void)[] = [];
			let settle: (fail: boolean) => void = () => {};
			const real = broker.source.subscribe;
			const source: StreamSource<Change> = {
				...broker.source,
				publish: async () => {
					throw new Error('ECONNREFUSED');
				},
				subscribe(handler, options) {
					return new Promise((resolve, reject) => {
						settle = (fail) => {
							if (fail) reject(new Error('ECONNREFUSED'));
							else resolve(real(handler, options));
						};
						settlers.push(settle);
					});
				},
			};
			return {
				source,
				settle: (fail: boolean) => settle(fail),
				settlers,
				broker,
			};
		}

		test('a locally delivered message reaches next() without waiting for the subscribe', async () => {
			const hanging = hangingBroker();
			const streams = createKeyedStreams(hanging.source, keyOf, {
				fallback: true,
			});
			const it = streams.stream('a');
			const pending = it.next();
			expect(await streams.publish(room('a', 3))).toBe(0);
			const started = performance.now();
			expect(await pending).toEqual({ value: room('a', 30), done: false });
			expect(performance.now() - started).toBeLessThan(500);
			hanging.settle(true);
			await streams.close();
		});

		test('the subscription still opens in the background once the server answers', async () => {
			const hanging = hangingBroker();
			const streams = createKeyedStreams(hanging.source, keyOf);
			const it = streams.stream('a');
			const pending = it.next();
			await Bun.sleep(5);
			hanging.settle(false);
			await Bun.sleep(5);
			expect(hanging.broker.state.subscribes).toBe(1);
			hanging.broker.source.publish(room('a', 4));
			expect(await pending).toEqual({ value: room('a', 4), done: false });
			await streams.close();
			expect(hanging.broker.state.closes).toBe(1);
		});

		test('return() while the subscribe is pending frees the listener and the late subscription', async () => {
			const hanging = hangingBroker();
			const streams = createKeyedStreams(hanging.source, keyOf);
			const it = streams.stream('a');
			const pending = it.next();
			await Bun.sleep(5);
			expect(await it.return(undefined)).toEqual({
				value: undefined,
				done: true,
			});
			expect(await pending).toEqual({ value: undefined, done: true });
			expect(streams.listeners).toBe(0);
			hanging.settle(false);
			await Bun.sleep(5);
			expect(hanging.broker.state.closes).toBe(1);
			expect(hanging.broker.listeners()).toBe(0);
		});

		test('close() resolves while the subscribe is pending, and closes the late subscription', async () => {
			const hanging = hangingBroker();
			const streams = createKeyedStreams(hanging.source, keyOf);
			const it = streams.stream('a');
			const pending = it.next();
			await Bun.sleep(5);
			const started = performance.now();
			await streams.close();
			expect(performance.now() - started).toBeLessThan(500);
			expect(await pending).toEqual({ value: undefined, done: true });
			hanging.settle(false);
			await Bun.sleep(5);
			expect(hanging.broker.state.closes).toBe(1);
			expect(hanging.broker.listeners()).toBe(0);
		});

		test('close() with a subscribe that later fails raises nothing', async () => {
			const unhandled: unknown[] = [];
			const note = (reason: unknown) => unhandled.push(reason);
			process.on('unhandledRejection', note);
			try {
				const hanging = hangingBroker();
				const streams = createKeyedStreams(hanging.source, keyOf);
				const it = streams.stream('a');
				void it.next();
				await Bun.sleep(5);
				await streams.close();
				hanging.settle(true);
				await Bun.sleep(10);
				expect(unhandled).toEqual([]);
				expect(hanging.broker.state.closes).toBe(0);
			} finally {
				process.off('unhandledRejection', note);
			}
		});

		test('a stream re-opened while the old subscribe is pending: the old one is closed, the new one delivers once', async () => {
			const hanging = hangingBroker();
			const streams = createKeyedStreams(hanging.source, keyOf);
			const first = streams.stream('a');
			void first.next();
			await Bun.sleep(5);
			await first.return(undefined);
			const second = streams.stream('a');
			const read = second.next();
			await Bun.sleep(5);
			expect(hanging.settlers).toHaveLength(2);
			for (const settle of hanging.settlers) settle(false);
			await Bun.sleep(5);
			expect(hanging.broker.state.closes).toBe(1);
			expect(hanging.broker.listeners()).toBe(1);
			await hanging.broker.source.publish(room('a', 5));
			expect(await read).toEqual({ value: room('a', 5), done: false });
			expect(
				await Promise.race([second.next(), Bun.sleep(20)]),
			).toBeUndefined();
			await streams.close();
			expect(hanging.broker.state.closes).toBe(2);
		});

		test('a superseded subscription that resolves late delivers nothing', async () => {
			const hanging = hangingBroker();
			const streams = createKeyedStreams(hanging.source, keyOf);
			const first = streams.stream('a');
			void first.next();
			await Bun.sleep(5);
			await first.return(undefined);
			const second = streams.stream('a');
			const read = second.next();
			await Bun.sleep(5);
			hanging.settlers[0]?.(false);
			// Resolved but not the current attempt: a publish now reaches nobody.
			await hanging.broker.source.publish(room('a', 6));
			expect(await Promise.race([read, Bun.sleep(20)])).toBeUndefined();
			hanging.settlers[1]?.(false);
			await Bun.sleep(5);
			await hanging.broker.source.publish(room('a', 7));
			expect(await read).toEqual({ value: room('a', 7), done: false });
			await streams.close();
		});
	});
});

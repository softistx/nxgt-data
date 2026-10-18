import { describe, expect, test } from 'bun:test';
import { deferred, fake } from '../../test/fake-worker';
import { rejection } from '../../test/rejection';
import { closeLife, openLife, trackWorker } from './life';

describe('tracked workers of a life', () => {
	test('closeLife closes every tracked worker, and a worker closed by hand leaves the set', async () => {
		const life = openLife();
		const a = fake();
		const b = fake();
		const byHand = fake();
		trackWorker(life, a.worker);
		trackWorker(life, b.worker);
		const tracked = trackWorker(life, byHand.worker);
		expect(life.workers.size).toBe(3);
		await tracked.close({ grace: 5 });
		expect(life.workers.size).toBe(2);
		expect(byHand.closes).toEqual([{ grace: 5 }]);
		await closeLife(life, 250);
		expect(a.closes).toEqual([{ grace: 250 }]);
		expect(b.closes).toEqual([{ grace: 250 }]);
		expect(byHand.closes.length).toBe(1);
		expect(life.workers.size).toBe(0);
		expect(life.state).toBe('closed');
	});

	test('a worker whose close rejects does not keep the others open: its error is rethrown after both phases, the first one when two reject', async () => {
		const life = openLife();
		const boom = new Error('boom');
		const bad = fake({ reject: boom });
		const worse = fake({ reject: new Error('worse') });
		const good = fake();
		trackWorker(life, bad.worker);
		trackWorker(life, worse.worker);
		trackWorker(life, good.worker);
		const error = await rejection(closeLife(life, undefined));
		expect(error).toBe(boom);
		expect(good.closes.length).toBe(1);
		expect(life.state).toBe('closed');
		expect(life.waits.size).toBe(0);
	});

	test('a sync throw from a worker close is caught like a rejection, and phase 2 still runs', async () => {
		const life = openLife();
		const boom = new Error('sync');
		trackWorker(life, fake({ throws: boom }).worker);
		const good = fake();
		trackWorker(life, good.worker);
		const error = await rejection(closeLife(life, undefined));
		expect(error).toBe(boom);
		expect(good.closes.length).toBe(1);
		expect(life.state).toBe('closed');
	});

	test('a worker closed by hand stays tracked until its close resolves, and closeLife waits for it', async () => {
		const life = openLife();
		const gate = deferred();
		const held = fake({ hold: gate.promise });
		const tracked = trackWorker(life, held.worker);
		const byHand = tracked.close();
		expect(life.workers.size).toBe(1);
		let closed = false;
		const all = closeLife(life, undefined).then(() => {
			closed = true;
		});
		await Bun.sleep(30);
		expect(closed).toBe(false);
		gate.release();
		await byHand;
		await all;
		expect(closed).toBe(true);
		expect(life.workers.size).toBe(0);
	});

	test('a close refused for a bad grace is not memoised: the worker stays tracked, and closeLife closes it', async () => {
		const life = openLife();
		const refused = fake({ refuse: new TypeError('bad grace') });
		const tracked = trackWorker(life, refused.worker);
		const error = await rejection(tracked.close({ grace: -1 }));
		expect((error as Error).message).toBe('bad grace');
		expect(life.workers.has(refused.worker)).toBe(true);
		await closeLife(life, 10);
		expect(life.workers.size).toBe(0);
		expect(refused.closes).toEqual([{ grace: -1 }, { grace: 10 }]);
	});

	test('asyncDispose on a tracked worker leaves the set once the close ends', async () => {
		const life = openLife();
		const gate = deferred();
		const tracked = trackWorker(life, fake({ hold: gate.promise }).worker);
		const disposed = tracked[Symbol.asyncDispose]();
		expect(life.workers.size).toBe(1);
		gate.release();
		await disposed;
		expect(life.workers.size).toBe(0);
	});
});

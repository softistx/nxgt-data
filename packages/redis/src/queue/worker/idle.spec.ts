import { describe, expect, test } from 'bun:test';
import { rejection } from '../../../test/rejection';
import type { WorkerContext } from './context';
import { markDrained, waitIdle } from './idle';

/** A context that looks idle, whose `ZCARD` answers `send`. */
function stubbed(send: () => Promise<unknown>) {
	let calls = 0;
	const context = {
		slots: new Set(),
		drained: true,
		open: true,
		claims: 0,
		idleWaiters: new Set(),
		client: {
			send: () => {
				calls += 1;
				return send();
			},
		},
		keys: { ready: 'r' },
	} as unknown as WorkerContext;
	return { context, calls: () => calls };
}

describe('waitIdle', () => {
	test('a job waiting in ready: one check, then it waits for the next claim without polling', async () => {
		const { context, calls } = stubbed(async () => 1);
		let resolved = false;
		const idle = waitIdle(context).then(() => {
			resolved = true;
		});
		await Bun.sleep(300);
		expect(calls()).toBe(1);
		expect(context.idleWaiters.size).toBe(1);
		expect(resolved).toBe(false);
		markDrained(context, true);
		await idle;
		expect(resolved).toBe(true);
	});

	test('resolves when the connection closes while the check is in flight', async () => {
		const { context } = stubbed(async () => {
			context.open = false;
			throw new Error('Connection closed');
		});
		await waitIdle(context);
	});

	test('rejects when the check fails and the worker is still open', async () => {
		const { context } = stubbed(async () => {
			throw new Error('boom');
		});
		const error = await rejection(waitIdle(context));
		expect((error as Error).message).toBe('boom');
	});
});

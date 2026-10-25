import { describe, expect, test } from 'bun:test';
import { rejection } from '../../test/rejection';
import { createLimit } from './limit';

function gate() {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

describe('createLimit', () => {
	test('admits at most max tasks at once, and starts the rest in order', async () => {
		const limit = createLimit(2);
		const started: number[] = [];
		const gates = Array.from({ length: 5 }, gate);
		let running = 0;
		let peak = 0;
		const runs = gates.map((g, i) =>
			limit(async () => {
				started.push(i);
				peak = Math.max(peak, ++running);
				await g.opened;
				running--;
				return i;
			}),
		);
		await Promise.resolve();
		expect(started).toEqual([0, 1]);
		gates[1]?.open();
		await runs[1];
		await Promise.resolve();
		expect(started).toEqual([0, 1, 2]);
		for (const g of gates) g.open();
		expect(await Promise.all(runs)).toEqual([0, 1, 2, 3, 4]);
		expect(started).toEqual([0, 1, 2, 3, 4]);
		expect(peak).toBe(2);
	});

	test("a failing task frees its place and its error is the caller's", async () => {
		const limit = createLimit(1);
		const failing = rejection(
			limit(async () => {
				throw new Error('boom');
			}),
		);
		const after = limit(async () => 'ran');
		expect(((await failing) as Error).message).toBe('boom');
		expect(await after).toBe('ran');
		expect(await limit(async () => 'again')).toBe('again');
	});

	test('with a max of 1 tasks run one by one', async () => {
		const limit = createLimit(1);
		let running = 0;
		let peak = 0;
		await Promise.all(
			Array.from({ length: 6 }, () =>
				limit(async () => {
					peak = Math.max(peak, ++running);
					await new Promise((resolve) => setTimeout(resolve, 2));
					running--;
				}),
			),
		);
		expect(peak).toBe(1);
	});
});

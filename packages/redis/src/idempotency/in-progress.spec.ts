import { describe, expect, test } from 'bun:test';
import { createOrder, gate, useClients, useRedis } from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { GuardError } from '../errors/guard-error';
import { bindIdempotency } from './bind-idempotency';

// Two runs of one key at once, over two clients. What happens when the key is
// taken from a run, and waiting for one, are in `lease/`.

const servers = useRedis();
const clients = useClients(servers);

function pair(definition: typeof createOrder) {
	const [a, b] = clients();
	return [
		bindIdempotency(a, definition),
		bindIdempotency(b, definition),
	] as const;
}

const who = { user: 'u1', key: 'k1' };

describe('while a run is pending', () => {
	test('another client’s run is IN_PROGRESS, with retryAfter what is left of the lease', async () => {
		const [a, b] = pair(createOrder);
		const { opened, open } = gate();
		let started = () => {};
		const running = new Promise<void>((resolve) => {
			started = resolve;
		});
		const first = a.run(who, async () => {
			started();
			await opened;
			return { orderId: 'o1', total: 1 };
		});
		await running;

		let calls = 0;
		const error = await rejection(
			b.run(who, () => {
				calls += 1;
				return { orderId: 'o2', total: 2 };
			}),
		);
		expect(error).toBeInstanceOf(GuardError);
		expect(error).toMatchObject({
			code: 'IN_PROGRESS',
			definition: 'orders.create',
		});
		const retryAfter = (error as GuardError).retryAfter ?? 0;
		expect(retryAfter).toBeGreaterThan(0);
		expect(retryAfter).toBeLessThanOrEqual(5000);
		expect(calls).toBe(0);

		open();
		expect((await first).replayed).toBe(false);
		const after = await b.run(who, () => ({ orderId: 'o2', total: 2 }));
		expect(after).toEqual({
			value: { orderId: 'o1', total: 1, status: 'placed' },
			replayed: true,
		});
	});

	test('a different fingerprint is MISMATCH even while it runs', async () => {
		const [a, b] = pair(createOrder);
		const { opened, open } = gate();
		const took = gate();
		const first = a.run(
			who,
			async () => {
				took.open();
				await opened;
				return { orderId: 'o1', total: 1 };
			},
			{ fingerprint: 'body one' },
		);
		await took.opened;

		const error = await rejection(
			b.run(who, () => ({ orderId: 'o2', total: 2 }), {
				fingerprint: 'body two',
			}),
		);
		expect(error).toMatchObject({ code: 'MISMATCH' });
		open();
		await first;
	});

	test('twenty runs at once over two clients call the work exactly once', async () => {
		const [a, b] = pair(createOrder);
		let calls = 0;
		const work = async () => {
			calls += 1;
			await Bun.sleep(20);
			return { orderId: 'o1', total: 1 };
		};
		const settled = await Promise.all(
			Array.from({ length: 20 }, (_, i) =>
				(i % 2 === 0 ? a : b).run(who, work).then(
					(result) => ({ result }),
					(error: unknown) => ({ error }),
				),
			),
		);
		expect(calls).toBe(1);
		const ran = settled.filter((s) => 'result' in s && !s.result.replayed);
		const refused = settled.filter((s) => 'error' in s);
		expect(ran).toHaveLength(1);
		for (const s of refused)
			expect(s).toMatchObject({ error: { code: 'IN_PROGRESS' } });
		// The rest replayed, if any arrived after it finished.
		expect(settled.length - ran.length - refused.length).toBeGreaterThanOrEqual(
			0,
		);
	});
});

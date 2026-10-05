import { afterAll, beforeAll, expect, test } from 'bun:test';
import { startMongo, type TestServer } from '../../test/server';
import { closeMongo, connectMongo } from './connect';

let t: TestServer;
let stopped = false;

beforeAll(async () => {
	t = await startMongo('nxgt-ping-lost');
}, 120_000);
afterAll(async () => {
	await closeMongo();
	if (!stopped) await t.stop();
});

const TIMEOUT_MS = 500;
/** timeoutMS, the grace (250 ms) and a margin: far from server selection's 30 s. */
const BOUND_MS = TIMEOUT_MS + 250 + 750;

test('a ping right after the server is lost answers within its deadline, each time', async () => {
	const mongo = await connectMongo(t.uri);
	expect((await mongo.ping()).ok).toBe(true);

	stopped = true;
	await t.stop();

	// Measured on mongodb 7.6.0: one ping fails fast on the dead socket, and
	// one of the next may wait serverSelectionTimeoutMS (30 s) with timeoutMS
	// ignored. Whether and when that wait comes varies with the machine — on
	// CI's two cores all five failed fast (2026-10-05) — so this asserts the
	// bound on every ping, which holds either way. That the timer's own answer
	// is a `ConnectionError` is pinned in `wiring/ping.spec.ts`, which reaches
	// the timer every time.
	for (const attempt of [1, 2, 3, 4, 5]) {
		const started = performance.now();
		const result = await mongo.ping({ timeoutMS: TIMEOUT_MS });
		const took = performance.now() - started;
		expect(result.ok, `ping ${attempt}`).toBe(false);
		expect(took, `ping ${attempt} took ${Math.round(took)} ms`).toBeLessThan(
			BOUND_MS,
		);
	}
	// `close()` would wait on the driver's own teardown; the client is gone.
}, 20_000);

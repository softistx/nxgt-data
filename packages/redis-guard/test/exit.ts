// Run as a process of its own by `src/idempotency/lease/heartbeat.spec.ts`,
// with the test Redis's URI: three runs that settle each way — a result, a
// throw, a key taken mid-run — then the client closed. The process must then
// exit by itself; a renewal timer left running would keep it alive.
//
// The lease is 3 s, so its first beat (1 s) comes long after each 100 ms
// `work`: no renewal runs during a run, and none can find the key done or
// gone and clear its own timer. A timer `run` failed to stop therefore
// fires only after `client.close()`, fails, is retried at every beat, and
// keeps the process alive — measured: with a 30 ms lease each stray beat
// cleared itself before the close, and the process exited anyway.
import { RedisClient } from 'bun';
import { z } from 'zod';
import { bindIdempotency, defineIdempotency } from '../src';

const client = new RedisClient(process.argv[2]);
await client.connect();
const bound = bindIdempotency(
	client,
	defineIdempotency({
		name: 'exit',
		key: (key: string) => key,
		ttl: 60,
		lease: 3_000,
		schema: z.number(),
	}),
);
const busy = async () => await Bun.sleep(100);

await bound.run('ok', async () => {
	await busy();
	return 1;
});
await bound
	.run('throws', async () => {
		await busy();
		throw new Error('thrown');
	})
	.catch(() => undefined);
await bound
	.run('lost', async () => {
		await bound.forget('lost');
		await busy();
		return 1;
	})
	.catch(() => undefined);
client.close();
console.log('settled');

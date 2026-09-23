// Run as a process of its own by `src/idempotency/lease/heartbeat.spec.ts`,
// with the test Redis's URI: three runs that settle each way — a result, a
// throw, a key taken mid-run — then the client closed. The process must then
// exit by itself; a renewal timer left running would keep it alive.
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
		lease: 30,
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

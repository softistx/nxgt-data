import { expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { gate, mailQueue, useRedis } from '../../../test/fixtures';
import { bindQueue } from '../bind-queue';
import { RELEASE_MS } from '../timers';

const servers = useRedis();

test('close resolves within the grace and RELEASE_MS while a settle never answers', async () => {
	const admin = new RedisClient(servers.redis.uri);
	const entered = gate();
	const release = gate();
	const worker = bindQueue(servers.redis.client, mailQueue).work(async () => {
		entered.open();
		await release.opened;
	});
	try {
		await bindQueue(servers.redis.client, mailQueue).add({ to: 'a' });
		await entered.opened;
		// Writes hang: the COMPLETE script the job settles with never answers.
		await admin.send('CLIENT', ['PAUSE', '5000', 'WRITE']);
		release.open();
		await Bun.sleep(100);
		const started = performance.now();
		await worker.close({ grace: 50 });
		expect(performance.now() - started).toBeLessThan(50 + RELEASE_MS + 1_000);
	} finally {
		await admin.send('CLIENT', ['UNPAUSE']);
		admin.close();
	}
}, 15_000);

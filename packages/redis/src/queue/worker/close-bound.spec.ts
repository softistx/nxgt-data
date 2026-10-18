import { expect, test } from 'bun:test';
import { RedisClient } from 'bun';
import { z } from 'zod';
import { eventually, gate, mailQueue, useRedis } from '../../../test/fixtures';
import { bindQueue } from '../bind-queue';
import { defineQueue } from '../define-queue';
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

const shortLease = defineQueue({
	name: 'mails',
	schema: z.object({ to: z.string() }),
	lease: 300,
});

test('a reply arriving after the bound starts no job, and the job is retaken', async () => {
	const admin = new RedisClient(servers.redis.uri);
	const bound = bindQueue(servers.redis.client, shortLease);
	const entered: string[] = [];
	const hold = gate();
	await bound.add({ to: 'a' }, { id: 'a' });
	await bound.add({ to: 'b' }, { id: 'b' });
	const worker = bound.work(async (job) => {
		entered.push(job.id);
		await hold.opened;
	});
	let fresh: ReturnType<typeof bound.work> | undefined;
	try {
		await eventually(() => entered.length, 1);
		// Writes hang: job a's COMPLETE, which would claim b, waits.
		await admin.send('CLIENT', ['PAUSE', '5000', 'WRITE']);
		hold.open();
		await Bun.sleep(100);
		await worker.close({ grace: 50 });
		await admin.send('CLIENT', ['UNPAUSE']);
		// Past the lease, so a job the late reply claimed would have lapsed.
		await Bun.sleep(700);
		expect(entered).toEqual(['a']);
		const retaken: string[] = [];
		fresh = bound.work(async (job) => {
			retaken.push(job.id);
		});
		await eventually(() => retaken.includes('b'), true);
	} finally {
		await admin.send('CLIENT', ['UNPAUSE']).catch(() => undefined);
		admin.close();
		await worker.close();
		await fresh?.close();
	}
}, 15_000);

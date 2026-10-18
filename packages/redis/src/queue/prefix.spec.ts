import { describe, expect, test } from 'bun:test';
import { gate, mailQueue, useRedis } from '../../test/fixtures';
import { bindQueue, bindQueueWith } from './bind-queue';
import type { BoundQueue } from './types';
import type { Worker } from './worker/types';

const servers = useRedis();
const client = () => servers.redis.client;
const under = (prefix: string) =>
	bindQueueWith(client(), mailQueue, { prefix, life: undefined });

/** The `job.key('send')` a worker on `queue` reads for the job `id`. */
async function keyOf(
	queue: BoundQueue<typeof mailQueue.schema>,
	id: string,
): Promise<string> {
	const read = gate();
	let seen = '';
	const worker: Worker = queue.work((job) => {
		seen = job.key('send');
		read.open();
	});
	try {
		await queue.add({ to: 'a@b.c' }, { id });
		await read.opened;
		return seen;
	} finally {
		await worker.close();
	}
}

describe('a queue bound under a prefix', () => {
	test('bound by hand: no prefix, the keys and job.key are unchanged', async () => {
		const queue = bindQueue(client(), mailQueue);
		expect(queue.prefix).toBeUndefined();
		expect(await keyOf(queue, 'j1')).toBe('mails:j1:send');
		expect(await client().exists('queue:{mails}:job:j1')).toBe(true);
	});

	test('under app:prod the keys are queue:{app:prod:mails}:…', async () => {
		const queue = under('app:prod');
		expect(queue.prefix).toBe('app:prod');
		await queue.add({ to: 'a@b.c' }, { id: 'j1' });
		expect(await client().exists('queue:{app:prod:mails}:job:j1')).toBe(true);
		expect(await client().keys('queue:{mails}:*')).toEqual([]);
	});

	test('under app:prod, job a:b gives job.key app:prod:mails:a:b:send', async () => {
		expect(await keyOf(under('app:prod'), 'a:b')).toBe(
			'app:prod:mails:a:b:send',
		);
	});

	test('the definition is the one given, frozen and unchanged', () => {
		const queue = under('app:prod');
		expect(queue.definition).toBe(mailQueue);
		expect(Object.isFrozen(queue.definition)).toBe(true);
		expect(queue.definition.name).toBe('mails');
	});

	test("two prefixes over one definition do not see each other's jobs", async () => {
		const a = under('a');
		const b = under('b');
		await a.add({ to: 'a@b.c' });
		await a.add({ to: 'a@b.c' });
		expect((await a.counts()).waiting).toBe(2);
		expect((await b.counts()).waiting).toBe(0);
	});

	test('a worker under a prefix hears a cancel on the prefixed events channel', async () => {
		const queue = under('app:prod');
		const started = gate();
		const aborted = gate();
		const worker = queue.work(async (job) => {
			job.signal.addEventListener('abort', () => aborted.open());
			started.open();
			await aborted.opened;
		});
		try {
			await queue.add({ to: 'a@b.c' }, { id: 'j1' });
			await started.opened;
			expect(await queue.cancel('j1')).toBe(true);
			await aborted.opened;
		} finally {
			await worker.close();
		}
	});
});

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	expect,
	test,
} from 'bun:test';
import { defineRedis, openRedis } from '@nxgt/redis';
import { RedisClient } from 'bun';
import { startRedis, type TestServer } from '../test/redis';
import { addWelcome } from './producer';
import { type AppRedis, wiring } from './redis';
import { type Deps, serve, work } from './worker';

let server: TestServer;
let redis: AppRedis;
let client: RedisClient;

beforeAll(async () => {
	server = await startRedis();
});
beforeEach(async () => {
	await server.client.send('FLUSHDB', []);
	// A client per test: a worker stores the definition's schedules once per
	// client, and the FLUSHDB above has just emptied them.
	client = new RedisClient(server.uri);
	redis = await openRedis(defineRedis({ client, ...wiring }));
});
// Closing the Redis closes its workers: one test's worker must not take the next one's jobs.
afterEach(async () => {
	await redis.close();
	client.close();
});
afterAll(async () => {
	await server.stop();
});

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A `sendMail` that records what it was given, and how many ran at once per tenant. */
function recorder(hold: Promise<void> = Promise.resolve()) {
	const sent: { to: string; idempotencyKey: string }[] = [];
	const running = new Map<string, number>();
	const peak = new Map<string, number>();
	const deps: Deps = {
		async sendMail(mail) {
			const tenant = mail.tenantId ?? '-';
			const now = (running.get(tenant) ?? 0) + 1;
			running.set(tenant, now);
			peak.set(tenant, Math.max(peak.get(tenant) ?? 0, now));
			await hold;
			running.set(tenant, (running.get(tenant) ?? 1) - 1);
			sent.push({ to: mail.to, idempotencyKey: mail.idempotencyKey });
		},
		async recordSent() {},
	};
	return { sent, peak, running, deps };
}

test('welcome mails of two tenants all run, at most two at once per tenant', async () => {
	// `sendMail` is held at a gate, so the cap is measured on state rather
	// than on how sleeps overlapped on a loaded machine.
	let open = () => {};
	const gate = new Promise<void>((done) => {
		open = done;
	});
	const { sent, peak, running, deps } = recorder(gate);
	for (let i = 0; i < 4; i++)
		await addWelcome(redis, 'acme', `a${i}@acme.test`);
	for (let i = 0; i < 3; i++)
		await addWelcome(redis, 'globex', `g${i}@globex.test`);

	const worker = work(redis, deps, { concurrency: 8 });
	const deadline = Date.now() + 5000;
	while (running.get('acme') !== 2 || running.get('globex') !== 2) {
		if (Date.now() > deadline) {
			throw new Error('each tenant did not reach 2 running within 5 s');
		}
		await sleep(10);
	}
	await sleep(200);
	expect(running.get('acme')).toBe(2);
	expect(running.get('globex')).toBe(2);

	open();
	await worker.idle();

	expect(sent).toHaveLength(7);
	expect(peak.get('acme')).toBe(2);
	expect(peak.get('globex')).toBe(2);
});

test('the digest is scheduled nightly, in the zone of the definition', async () => {
	const worker = work(redis, recorder().deps);
	// The first worker stores the definition's schedules, a moment after it starts.
	const deadline = Date.now() + 5000;
	let schedules = await redis.queues.mails.schedules.list();
	while (schedules.length === 0) {
		if (Date.now() > deadline) {
			throw new Error('the worker did not store the schedules within 5 s');
		}
		await sleep(20);
		schedules = await redis.queues.mails.schedules.list();
	}
	await worker.close();

	const [digest, ...others] = schedules;
	expect(others).toHaveLength(0);
	expect(digest).toMatchObject({
		id: 'digest',
		origin: 'definition',
		timezone: 'Europe/Paris',
	});
	const parts = new Intl.DateTimeFormat('en-GB', {
		timeZone: 'Europe/Paris',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).format(digest?.next);
	expect(parts).toBe('03:00');
	expect(digest?.next.getTime()).toBeGreaterThan(Date.now());
});

test('a retried job does not send again', async () => {
	const { sent, deps } = recorder();
	let recorded = 0;
	deps.recordSent = async () => {
		if (++recorded === 1) throw new Error('database down');
	};
	const handle = await addWelcome(redis, 'acme', 'ada@acme.test');

	const worker = work(redis, deps);
	await handle.finished();
	await worker.close();

	expect(recorded).toBe(2);
	expect(sent).toHaveLength(1);
	expect(sent[0]?.idempotencyKey).toBe(`saas:mails:${handle.id}:send`);
});

test('the worker closes on SIGTERM and the running job finishes first', async () => {
	let release = () => {};
	const gate = new Promise<void>((done) => {
		release = done;
	});
	let started = () => {};
	const running = new Promise<void>((done) => {
		started = done;
	});
	const { sent, deps } = recorder();
	const sendMail = deps.sendMail;
	deps.sendMail = async (mail) => {
		started();
		await gate;
		await sendMail(mail);
	};
	const handle = await addWelcome(redis, 'acme', 'ada@acme.test');
	const done = handle.finished();

	let stopped = false;
	const served = serve(redis, deps).then(() => {
		stopped = true;
	});
	await running;
	process.kill(process.pid, 'SIGTERM');
	// What this proves: close waits for the running job, so `serve` has not
	// resolved after 100 ms with the job held. It does not prove the grace
	// bound (20 s here); the package's own specs measure that.
	await sleep(100);
	expect(stopped).toBe(false);

	release();
	await served;
	expect(await done).toEqual({ subject: 'Welcome' });
	expect(sent).toHaveLength(1);
});

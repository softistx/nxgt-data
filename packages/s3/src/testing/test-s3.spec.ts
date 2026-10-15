import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Client } from 'bun';
import { rejection, rejectionMessage } from '../../test/rejection';
import { SEAWEEDFS_CACHE } from '../../test/server';
import { bindBucket } from '../bucket/bind-bucket';
import { defineBucket } from '../bucket/define-bucket';
import { startTestS3, type TestS3 } from '.';
import { seaweedfsBinary } from './seaweedfs';
import { socketsOf } from './weed';

// `@nxgt/s3/testing`, as a consumer's suite uses it. The binary is the one
// `scripts/seaweedfs.ts` cached before the specs.

const started: TestS3[] = [];

afterEach(async () => {
	for (const s3 of started.splice(0)) await s3.stop();
});

async function start(
	options?: Parameters<typeof startTestS3>[0],
): Promise<TestS3> {
	const s3 = await startTestS3({ cacheDir: SEAWEEDFS_CACHE, ...options });
	started.push(s3);
	return s3;
}

/** Runs `fn` with `$WEED_BIN` set to `value`, and puts it back. */
async function withBin<T>(value: string, fn: () => Promise<T>): Promise<T> {
	const before = process.env['WEED_BIN'];
	process.env['WEED_BIN'] = value;
	try {
		return await fn();
	} finally {
		if (before === undefined) delete process.env['WEED_BIN'];
		else process.env['WEED_BIN'] = before;
	}
}

const notes = defineBucket({
	bucket: 'notes',
	key: (id: string) => `${id}.txt`,
});

describe('startTestS3', () => {
	test('createBucket, then bindBucket puts and reads through options', async () => {
		const s3 = await start();
		await s3.createBucket('notes');
		const store = bindBucket(notes, s3.options);
		await store.put('a', 'hello');
		expect(await store.text('a')).toBe('hello');
		expect(s3.region).toBe(s3.options.region);
		expect(s3.endpoint).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
	}, 120_000);

	test('uses the binary $WEED_BIN names', async () => {
		const binary = await seaweedfsBinary({ cacheDir: SEAWEEDFS_CACHE });
		// A wrapper that proves it ran, then execs the real one.
		const wrapper = `${tmpdir()}/weed-wrapper-${process.pid}`;
		const marker = `${wrapper}.ran`;
		await Bun.write(
			wrapper,
			`#!/bin/sh\ntouch ${marker}\nexec ${binary} "$@"\n`,
		);
		await Bun.$`chmod +x ${wrapper}`;
		try {
			const s3 = await withBin(wrapper, () =>
				startTestS3({ cacheDir: '/nowhere' }),
			);
			started.push(s3);
			expect(await Bun.file(marker).exists()).toBe(true);
		} finally {
			await Bun.$`rm -f ${wrapper} ${marker}`;
		}
	}, 120_000);

	test('binary wins over $WEED_BIN', async () => {
		const binary = await seaweedfsBinary({ cacheDir: SEAWEEDFS_CACHE });
		const s3 = await withBin('/nowhere/weed', () => startTestS3({ binary }));
		started.push(s3);
		await s3.createBucket('notes');
	}, 120_000);

	test('two servers at once are separate', async () => {
		const [a, b] = await Promise.all([start(), start()]);
		expect(a.endpoint).not.toBe(b.endpoint);
		await a.createBucket('notes');
		await b.createBucket('notes');
		await bindBucket(notes, a.options).put('only-a', 'a');
		expect(await bindBucket(notes, b.options).text('only-a')).toBeUndefined();
	}, 120_000);

	test('reset empties a bucket and leaves the others', async () => {
		const s3 = await start();
		await s3.createBucket('notes');
		await s3.createBucket('other');
		const store = bindBucket(notes, s3.options);
		for (const id of ['a', 'b', 'c']) await store.put(id, id);
		const other = new S3Client({ ...s3.options, bucket: 'other' });
		await other.write('keep', 'x');
		await s3.reset('notes');
		expect(await store.text('a')).toBeUndefined();
		expect(await store.text('c')).toBeUndefined();
		expect(await other.file('keep').text()).toBe('x');
	}, 120_000);

	test('stop refuses connections, is a no-op the second time, and removes the temp dir', async () => {
		// A temp directory of its own, so no other process's server is counted.
		const mine = await mkdtemp(join(tmpdir(), 'stop-spec-'));
		const before = process.env['TMPDIR'];
		process.env['TMPDIR'] = mine;
		try {
			const s3 = await start();
			expect(await readdir(mine)).toContainEqual(
				expect.stringMatching(/^nxgt-s3-/),
			);
			await s3.stop();
			await s3.stop();
			expect(await rejection(fetch(s3.endpoint))).toBeInstanceOf(Error);
			expect(await readdir(mine)).toEqual([]);
		} finally {
			if (before === undefined) delete process.env['TMPDIR'];
			else process.env['TMPDIR'] = before;
			await rm(mine, { recursive: true, force: true });
		}
	}, 120_000);

	test('createBucket refuses a name S3 would not accept, at once', async () => {
		const s3 = await start();
		for (const name of [
			'x',
			'Upper',
			'a'.repeat(64),
			'-lead',
			'trail-',
			'un_der',
		]) {
			expect(await rejectionMessage(s3.createBucket(name))).toContain(
				'is not a bucket name S3 accepts',
			);
		}
	}, 120_000);

	test('stop leaves none of its socket paths or log files behind', async () => {
		const logs = async () =>
			(await readdir(tmpdir())).filter((name) => name.startsWith('weed.'));
		const logsBefore = await logs();
		const s3 = await start();
		const port = Number(new URL(s3.endpoint).port);
		const paths = socketsOf([
			port,
			port + 1,
			port + 2,
			port + 3,
			port + 4,
			port + 5,
			port + 6,
			port + 7,
		]);
		expect(paths).toContain(`/tmp/seaweedfs-s3-${port}.sock`);
		await s3.stop();
		for (const path of paths) expect(await Bun.file(path).exists()).toBe(false);
		// glog's `weed.<host>.<user>.log.*` files and `weed.INFO` links.
		expect((await logs()).filter((n) => !logsBefore.includes(n))).toEqual([]);
	}, 120_000);

	test('says so when binary points at nothing', async () => {
		expect(
			await rejectionMessage(startTestS3({ binary: '/nowhere/weed' })),
		).toContain('binary is /nowhere/weed, which does not exist');
	});

	test('reset throws for a bucket that was never created', async () => {
		const s3 = await start();
		expect(await rejection(s3.reset('never-created'))).toBeInstanceOf(Error);
	}, 120_000);

	test('stop removes the exit and signal handlers it added', async () => {
		const count = () =>
			['exit', 'SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name));
		const before = count();
		const s3 = await start();
		expect(count().every((n, i) => n === (before[i] ?? 0) + 1)).toBe(true);
		await s3.stop();
		expect(count()).toEqual(before);
	}, 120_000);

	test('createBucket on a stopped server says it exited, with its log', async () => {
		const s3 = await start();
		await s3.stop();
		expect(await rejectionMessage(s3.createBucket('late'))).toContain(
			'SeaweedFS exited before it served S3',
		);
	}, 120_000);

	test('says so when WEED_BIN points at nothing', async () => {
		await withBin('/nowhere/weed', async () => {
			expect(await rejectionMessage(startTestS3())).toContain(
				'WEED_BIN is /nowhere/weed, which does not exist',
			);
		});
	});
});

describe('a server nobody stops', () => {
	/** Runs a script that starts a server and then does `after`, as a child. */
	async function run(after: string) {
		const dir = await mkdtemp(join(tmpdir(), 'forgot-'));
		const script = join(dir, 'forgot.ts');
		const testing = new URL('./index.ts', import.meta.url).pathname;
		await Bun.write(
			script,
			`import { startTestS3 } from ${JSON.stringify(testing)};
const s3 = await startTestS3({ cacheDir: ${JSON.stringify(SEAWEEDFS_CACHE)} });
console.log(s3.endpoint);
${after}`,
		);
		const child = Bun.spawn(['bun', script], {
			stdout: 'pipe',
			stderr: 'inherit',
		});
		const reader = child.stdout.getReader();
		const first = await reader.read();
		const endpoint = new TextDecoder().decode(first.value).trim();
		return { child, endpoint, dir };
	}

	test('a script that never calls stop() ends on its own and leaves no weed', async () => {
		const { child, endpoint, dir } = await run('');
		try {
			expect(await child.exited).toBe(0);
			expect(await rejection(fetch(endpoint))).toBeInstanceOf(Error);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 120_000);

	test('SIGTERM kills the server and ends the process as the default would', async () => {
		const { child, endpoint, dir } = await run('setInterval(() => {}, 1000);');
		try {
			child.kill('SIGTERM');
			expect(await child.exited).toBe(143);
			expect(await rejection(fetch(endpoint))).toBeInstanceOf(Error);
			// Its temp directory and sockets go with it.
			const port = Number(new URL(endpoint).port);
			for (const path of socketsOf([
				port,
				port + 1,
				port + 2,
				port + 3,
				port + 4,
				port + 5,
				port + 6,
				port + 7,
			])) {
				expect(await Bun.file(path).exists()).toBe(false);
			}
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	}, 120_000);
});

import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { join } from 'node:path';
import { S3Client } from 'bun';
import {
	bytes,
	folder,
	keyPair,
	memorySource,
	memoryTarget,
} from '../../test/fixtures';
import { rejection } from '../../test/rejection';
import { startS3, type TestServer } from '../../test/s3-server';
import { bindBackup } from '../backups/bind-backup';
import { generateSigningKeys } from '../crypto/signing';
import { defineBackup } from '../definition/define-backup';
import { localRepository } from './local';
import { s3Repository } from './s3';

let server: TestServer;
let client: S3Client;
let tmp: Awaited<ReturnType<typeof folder>>;

beforeAll(async () => {
	server = await startS3(['backups']);
	client = new S3Client({ ...server.options, bucket: 'backups' });
}, 120_000);
afterAll(() => server.stop());
beforeEach(async () => {
	await server.reset('backups');
	tmp = await folder();
});
afterEach(() => tmp.remove());

async function fileOf(content: Uint8Array | string): Promise<string> {
	const path = join(tmp.path, crypto.randomUUID());
	await Bun.write(path, content);
	return path;
}

async function keys(repository: ReturnType<typeof s3Repository>, prefix = '') {
	const found: string[] = [];
	for await (const key of repository.list(prefix)) found.push(key);
	return found.sort();
}

type Writer = ReturnType<ReturnType<S3Client['file']>['writer']>;

/** `client`, its multipart writers swapped for what `wrap` makes of them. */
function withWriter(
	client: S3Client,
	wrap: (writer: Writer) => Pick<Writer, 'write' | 'flush' | 'end'>,
): S3Client {
	return new Proxy(client, {
		get(target, property, receiver) {
			if (property === 'file') {
				return (key: string) => {
					const file = target.file(key);
					return {
						writer: (options: object) => wrap(file.writer(options)),
						stat: () => file.stat(),
					};
				};
			}
			const value = Reflect.get(target, property, receiver);
			return typeof value === 'function' ? value.bind(target) : value;
		},
	});
}

describe('s3Repository', () => {
	test('put, get, list and delete, under its prefix', async () => {
		const repository = s3Repository({ client, prefix: 'nightly/eu' });
		expect(repository.name).toBe('s3');
		await repository.put('app/one/0.age', await fileOf('hello'));
		await repository.put('app/two/0.age', await fileOf(''));
		await repository.put('other/x', await fileOf('x'));
		expect(await client.exists('nightly/eu/app/one/0.age')).toBe(true);

		const stream = await repository.get('app/one/0.age');
		expect(await new Response(stream).text()).toBe('hello');
		expect(
			await new Response(await repository.get('app/two/0.age')).text(),
		).toBe('');
		expect(await repository.get('app/none')).toBeUndefined();
		expect(await keys(repository, 'app/')).toEqual([
			'app/one/0.age',
			'app/two/0.age',
		]);
		expect(await keys(repository)).toHaveLength(3);

		await repository.delete('app/one/0.age');
		await repository.delete('app/one/0.age');
		expect(await keys(repository, 'app/')).toEqual(['app/two/0.age']);
	});

	test('a listing longer than one page is listed whole', async () => {
		const repository = s3Repository({ client });
		const file = await fileOf('x');
		const names = Array.from(
			{ length: 1005 },
			(_, i) => `many/${String(i).padStart(4, '0')}`,
		);
		for (let i = 0; i < names.length; i += 50) {
			await Promise.all(
				names.slice(i, i + 50).map((key) => repository.put(key, file)),
			);
		}
		expect(await keys(repository, 'many/')).toEqual(names);
	}, 120_000);

	test('an object over 64 MiB goes in parts, and comes back byte for byte', async () => {
		const repository = s3Repository({ client, partSize: 8 * 1024 * 1024 });
		const content = bytes(65 * 1024 * 1024 + 7);
		await repository.put('big/0.age', await fileOf(content));
		expect((await client.file('big/0.age').stat()).etag).toMatch(/-\d+"$/);
		const back = new Uint8Array(
			await new Response(await repository.get('big/0.age')).arrayBuffer(),
		);
		expect(back.length).toBe(content.length);
		expect(Bun.hash(back)).toBe(Bun.hash(content));
	}, 120_000);

	test('a write the client reports and the store does not hold is refused', async () => {
		const forgetful = new Proxy(client, {
			get(target, property, receiver) {
				if (property === 'write') return async () => 0;
				const value = Reflect.get(target, property, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const repository = s3Repository({ client: forgetful });
		const error = await rejection(
			repository.put('lost', await fileOf('hello')),
		);
		expect((error as { code?: unknown }).code).toBe('NoSuchKey');
	});

	test('a short object is refused rather than taken whole', async () => {
		const short = new Proxy(client, {
			get(target, property, receiver) {
				if (property === 'write') {
					return (key: string, body: Uint8Array) =>
						target.write(key, body.subarray(0, body.length - 1));
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const error = await rejection(
			s3Repository({ client: short }).put('short', await fileOf('hello')),
		);
		expect(error).toHaveProperty(
			'message',
			's3 repository: an object was not stored whole',
		);
	});

	test('an upload whose local read fails is ended, then deleted', async () => {
		let writes = 0;
		const failing = withWriter(client, (writer) => ({
			write: (chunk: Uint8Array) => {
				if (++writes > 2) throw new Error('disk gone');
				return writer.write(chunk);
			},
			flush: () => writer.flush(),
			end: () => writer.end(),
		}));
		const repository = s3Repository({
			client: failing,
			partSize: 5 * 1024 * 1024,
		});
		const error = await rejection(
			repository.put('cut/0.age', await fileOf(bytes(65 * 1024 * 1024 + 1))),
		);
		expect(error).toHaveProperty('message', 'disk gone');
		expect(await client.exists('cut/0.age')).toBe(false);
	}, 120_000);

	test('an upload the store refuses at the end rejects', async () => {
		const refusing = withWriter(client, (writer) => ({
			write: (chunk: Uint8Array) => writer.write(chunk),
			flush: () => writer.flush(),
			end: async () => {
				throw Object.assign(new Error('refused'), { code: 'InternalError' });
			},
		}));
		const error = await rejection(
			s3Repository({ client: refusing }).put(
				'refused/0.age',
				await fileOf(bytes(65 * 1024 * 1024 + 1)),
			),
		);
		expect(error).toHaveProperty('code', 'InternalError');
	}, 120_000);

	test('a page cut short with no token is refused, not taken as the end', async () => {
		const cut = new Proxy(client, {
			get(target, property, receiver) {
				if (property === 'list') {
					return async () => ({
						isTruncated: true,
						contents: [{ key: 'a/0.age' }],
					});
				}
				const value = Reflect.get(target, property, receiver);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
		const error = await rejection(keys(s3Repository({ client: cut }), 'a/'));
		expect(error).toHaveProperty(
			'message',
			's3 repository: a listing page was cut short with no way to go on',
		);
	});

	test('what could never work is refused, quoting nothing', () => {
		expect(() => s3Repository({ client, prefix: '../x' })).toThrow(
			's3Repository: prefix must be a relative path of plain segments',
		);
		expect(() => s3Repository({ client, prefix: 'a//b' })).toThrow('prefix');
		expect(() => s3Repository({ client, partSize: 1024 })).toThrow(
			's3Repository: partSize must be 5 MiB at least',
		);
		const repository = s3Repository({ client });
		for (const key of ['../x', 'a//b', 'a/./b', '/x']) {
			expect(() => repository.get(key)).toThrow(
				's3 repository: a key is not a relative path',
			);
		}
		for (const prefix of ['../', 'a//', '/x/']) {
			expect(() => repository.list(prefix)).toThrow(
				's3 repository: a key is not a relative path',
			);
		}
	});
});

describe('a backup on S3, beside a local folder', () => {
	test('both hold it, signed; restore reads it back from S3', async () => {
		const keys = await keyPair();
		const signing = generateSigningKeys();
		const backups = bindBackup(defineBackup({ name: 'app' }), {
			repositories: [
				localRepository({ path: join(tmp.path, 'local') }),
				s3Repository({ client, prefix: 'nightly' }),
			],
			recipients: [keys.recipient],
			tmpDir: tmp.path,
			signing: { key: signing.privateKey },
		});
		const created = await backups.create(
			memorySource({ 'a.txt': 'alpha', 'b/c.bin': bytes(200_000) }),
		);
		expect(created.outcomes).toEqual([
			{ repository: 'local', stored: true },
			{ repository: 's3', stored: true },
		]);
		expect(
			(await backups.list({ from: 's3' })).backups.map((b) => b.id),
		).toEqual([created.id]);
		const verified = await backups.verify(created.id, {
			from: 's3',
			identities: [keys.identity],
		});
		expect(verified.signatureChecked).toBe(true);
		const target = memoryTarget();
		await backups.restore(created.id, target, {
			from: 's3',
			identities: [keys.identity],
		});
		expect(new TextDecoder().decode(target.written.get('a.txt'))).toBe('alpha');
		expect(target.written.get('b/c.bin')).toEqual(bytes(200_000));
	});
});

describe('the lock on S3', () => {
	test('two writers at once: never both', async () => {
		const keys = await keyPair();
		for (let round = 0; round < 5; round++) {
			const backups = bindBackup(defineBackup({ name: `race${round}` }), {
				repositories: [s3Repository({ client })],
				recipients: [keys.recipient],
				tmpDir: tmp.path,
			});
			const results = await Promise.allSettled([
				backups.create(memorySource({ a: 'alpha' })),
				backups.create(memorySource({ b: 'beta' })),
			]);
			const stored = results.filter((r) => r.status === 'fulfilled').length;
			expect(stored).toBeLessThanOrEqual(1);
			expect((await backups.list()).backups).toHaveLength(stored);
			expect(
				(await client.list({ prefix: `race${round}/locks/` })).contents ?? [],
			).toEqual([]);
		}
	}, 120_000);
});

describe('prune on S3', () => {
	test('removes every object of what goes, and keeps a held backup', async () => {
		const keys = await keyPair();
		const backups = bindBackup(defineBackup({ name: 'rot' }), {
			repositories: [s3Repository({ client, prefix: 'p' })],
			recipients: [keys.recipient],
			tmpDir: tmp.path,
		});
		const one = async (name: string) =>
			(await backups.create(memorySource({ [name]: name }))).id;
		const a = await one('a');
		const b = await one('b');
		const c = await one('c');
		await backups.hold(a);
		const pruned = await backups.prune({ keep: { last: 1 } });
		expect(pruned.removed.map((d) => d.id)).toEqual([b]);
		const left = (await client.list({ prefix: 'p/rot/' })).contents ?? [];
		expect(left.some((o) => o.key?.includes(b))).toBe(false);
		expect((await backups.list()).backups.map((x) => [x.id, x.held])).toEqual([
			[a, true],
			[c, false],
		]);
	}, 120_000);
});

describe('incremental on S3', () => {
	test('stores what changed and restores the whole view', async () => {
		const keys = await keyPair();
		const backups = bindBackup(defineBackup({ name: 'inc' }), {
			repositories: [s3Repository({ client, prefix: 'p' })],
			recipients: [keys.recipient],
			tmpDir: tmp.path,
		});
		const full = await backups.create(memorySource({ a: 'a', b: 'b' }));
		const next = await backups.create(memorySource({ a: 'a', b: 'B' }), {
			kind: 'incremental',
			identities: [keys.identity],
		});
		expect(next).toMatchObject({ parent: full.id, reused: 1 });
		const target = memoryTarget();
		await backups.restore(next.id, target, { identities: [keys.identity] });
		expect(
			[...target.written].map(([n, v]) => [n, new TextDecoder().decode(v)]),
		).toEqual([
			['a', 'a'],
			['b', 'B'],
		]);
	}, 120_000);
});

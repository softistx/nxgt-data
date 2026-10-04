import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from 'bun:test';
import { BSON } from 'mongodb';
import { type Harness, harness } from '../test/fixtures';
import { startMongo, type TestServer } from '../test/mongo';
import { rejection } from '../test/rejection';
import { MongoBackupError } from './errors';
import { mongoSource } from './source/mongo-source';
import { mongoTarget } from './target/mongo-target';

let server: TestServer;
let h: Harness;

beforeAll(async () => {
	server = await startMongo();
});
afterAll(() => server.stop());
beforeEach(async () => {
	await server.reset();
	await server.client.db('restored').dropDatabase();
	h = await harness();
});
afterEach(async () => {
	await server.clearFailures();
	await h.remove();
});

const restored = () => server.client.db('restored');

function expectCode(error: unknown, code: string, message: string): void {
	expect(error).toBeInstanceOf(MongoBackupError);
	expect(error).toHaveProperty('code', code);
	expect(error).toHaveProperty('message', message);
}

describe('the options', () => {
	test('a source needs a Db and a collection filter it reads', () => {
		for (const options of [
			undefined,
			{},
			{ db: {} },
			{ db: { databaseName: 'x' } },
			{ db: { watch: () => undefined } },
			{ db: server.db, collections: 'a' },
			{ db: server.db, collections: [1] },
		]) {
			expect(() => mongoSource(options as never)).toThrow(TypeError);
		}
	});

	test('a target needs a Db and an absolute tmpDir', () => {
		for (const options of [
			undefined,
			{ db: {} },
			{ db: { databaseName: 'x' } },
			{ db: { collection: () => undefined } },
			{ db: server.db, tmpDir: 'relative' },
		]) {
			expect(() => mongoTarget(options as never)).toThrow(TypeError);
		}
	});
});

describe('a restore refuses an entry', () => {
	const stream = (text: string) =>
		new Response(text).body as ReadableStream<Uint8Array>;

	test('whose name, metadata or order is not one this version writes', async () => {
		const cases: [string, string, string][] = [
			[
				'other/a',
				'',
				'mongoTarget: an entry name is not one this version writes',
			],
			[
				'metadata/a',
				'{}',
				'mongoTarget: a metadata entry is not one this version wrote',
			],
			[
				'documents/a',
				'',
				'mongoTarget: a collection’s documents came before its metadata',
			],
			[
				'changes/000001',
				'xxxxx',
				'mongoTarget: an entry is not a sequence of BSON documents',
			],
		];
		for (const [name, body, message] of cases) {
			const error = await rejection(
				mongoTarget({ db: restored() }).write(name, stream(body)),
			);
			expectCode(error, 'MALFORMED', message);
		}
	});

	test('a change that is not one this version wrote', async () => {
		const bytes = BSON.serialize({ op: 'insert', coll: 'a' });
		const error = await rejection(
			mongoTarget({ db: restored() }).write(
				'changes/000001',
				new Response(new Uint8Array(bytes)).body as ReadableStream<Uint8Array>,
			),
		);
		expectCode(
			error,
			'MALFORMED',
			'mongoTarget: a change is not one this version wrote',
		);
	});
});

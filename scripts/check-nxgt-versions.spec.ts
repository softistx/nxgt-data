import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import {
	behind,
	latestOf,
	type Manifest,
	read,
	report,
	tracked,
} from './check-nxgt-versions';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');

const manifests: Manifest[] = [
	{
		dir: 'packages/mongo-kit',
		name: '@nxgt/mongo-kit',
		devDependencies: {
			'@nxgt/mongo': 'workspace:^',
			'@nxgt/openapi-codegen': '^0.18.1',
			mongodb: '^7.6.0',
		},
	},
	{
		dir: 'examples/hono-api',
		name: 'hono-api-example',
		devDependencies: {
			'@nxgt/mongo-kit': 'workspace:^',
			'@nxgt/openapi-codegen': '^0.18.1',
			'@nxgt/openapi-hono': '0.3.1',
		},
	},
	{ dir: 'packages/mongo', name: '@nxgt/mongo', devDependencies: {} },
];

const lock = {
	'@nxgt/mongo': ['@nxgt/mongo@workspace:packages/mongo'],
	'@nxgt/openapi-codegen': ['@nxgt/openapi-codegen@0.18.1', '', {}, 'sha512-a'],
	'@nxgt/openapi-hono': ['@nxgt/openapi-hono@0.3.1', '', {}, 'sha512-b'],
	mongodb: ['mongodb@7.6.0', '', {}, 'sha512-c'],
};

describe('tracked', () => {
	test('lists the @nxgt/* devDependencies from outside, with who names them and what is locked', () => {
		expect(tracked(manifests, lock)).toEqual([
			{
				name: '@nxgt/openapi-codegen',
				dirs: ['examples/hono-api', 'packages/mongo-kit'],
				locked: ['0.18.1'],
			},
			{
				name: '@nxgt/openapi-hono',
				dirs: ['examples/hono-api'],
				locked: ['0.3.1'],
			},
		]);
	});

	test('skips a sibling, even when the lock names it', () => {
		const names = tracked(manifests, lock).map((one) => one.name);
		expect(names).not.toContain('@nxgt/mongo');
		expect(names).not.toContain('@nxgt/mongo-kit');
	});

	test('holds every version the lock resolves, oldest first', () => {
		const [mongo] = tracked(manifests, {
			'@nxgt/openapi-codegen': ['@nxgt/openapi-codegen@0.18.1'],
			'hono-api-example/@nxgt/mongo': ['@nxgt/openapi-codegen@0.17.1'],
		});
		expect(mongo?.locked).toEqual(['0.17.1', '0.18.1']);
	});

	test('reads an empty lock as nothing locked', () => {
		expect(tracked(manifests, {}).map((one) => one.locked)).toEqual([[], []]);
	});
});

describe('tracked, on what is not a release', () => {
	test('skips a workspace: devDependency whose package the list does not hold', () => {
		const [mongo] = manifests;
		expect(tracked(mongo === undefined ? [] : [mongo], lock)).toEqual([
			{
				name: '@nxgt/openapi-codegen',
				dirs: ['packages/mongo-kit'],
				locked: ['0.18.1'],
			},
		]);
	});

	test('skips a lock entry that is not a registry version', () => {
		const [mongo] = tracked(manifests, {
			'@nxgt/openapi-codegen': ['@nxgt/openapi-codegen@0.18.1'],
			'hono-api-example/@nxgt/mongo': [
				'@nxgt/openapi-codegen@github:softistx/nxgt-http',
			],
		});
		expect(mongo?.locked).toEqual(['0.18.1']);
	});
});

describe('behind', () => {
	const packages = tracked(manifests, lock);

	test('answers nothing when every lock is at latest', () => {
		expect(
			behind(
				packages,
				new Map([
					['@nxgt/openapi-codegen', '0.18.1'],
					['@nxgt/openapi-hono', '0.3.1'],
				]),
			),
		).toEqual([]);
	});

	test('answers a package whose lock is below latest, by semver and not by text', () => {
		expect(
			behind(
				packages,
				new Map([
					['@nxgt/openapi-codegen', '0.18.1'],
					['@nxgt/openapi-hono', '0.10.0'],
				]),
			),
		).toEqual([
			{
				name: '@nxgt/openapi-hono',
				dirs: ['examples/hono-api'],
				locked: '0.3.1',
				latest: '0.10.0',
			},
		]);
	});

	test('does not report a lock ahead of latest, as after a dist-tag moved back', () => {
		expect(
			behind(
				packages,
				new Map([
					['@nxgt/openapi-codegen', '0.18.0'],
					['@nxgt/openapi-hono', '0.3.1'],
				]),
			),
		).toEqual([]);
	});

	test('answers a package the lock does not hold', () => {
		expect(
			behind(
				tracked(manifests, {}),
				new Map([
					['@nxgt/openapi-codegen', '0.18.1'],
					['@nxgt/openapi-hono', '0.3.1'],
				]),
			).map((one) => one.locked),
		).toEqual([null, null]);
	});

	test('throws when latest is unknown, rather than calling it current', () => {
		expect(() =>
			behind(packages, new Map([['@nxgt/openapi-codegen', '0.18.1']])),
		).toThrow('no latest version for @nxgt/openapi-hono');
	});
});

describe('report', () => {
	test('names the package, both versions and where it is declared', () => {
		expect(
			report([
				{
					name: '@nxgt/openapi-codegen',
					dirs: ['examples/hono-api', 'packages/mongo-kit'],
					locked: '0.17.1',
					latest: '0.18.1',
				},
				{
					name: '@nxgt/openapi-hono',
					dirs: ['examples/hono-api'],
					locked: null,
					latest: '0.3.1',
				},
			]),
		).toEqual([
			'@nxgt/openapi-codegen: 0.17.1 → 0.18.1 (examples/hono-api, packages/mongo-kit)',
			'@nxgt/openapi-hono: not in bun.lock → 0.3.1 (examples/hono-api)',
		]);
	});
});

describe('latestOf', () => {
	const answer = (body: unknown, status = 200) =>
		spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify(body), { status }),
		);

	afterEach(() => {
		(
			globalThis.fetch as unknown as { mockRestore?: () => void }
		).mockRestore?.();
	});

	test("reads the latest dist-tag's version, at the scoped name escaped", async () => {
		const spy = answer({ version: '0.18.1' });
		expect(await latestOf('@nxgt/openapi-codegen')).toBe('0.18.1');
		expect(spy).toHaveBeenCalledWith(
			'https://registry.npmjs.org/@nxgt%2fopenapi-codegen/latest',
		);
	});

	test('throws when the registry does not answer 2xx, rather than calling it current', async () => {
		answer({ error: 'Not found' }, 404);
		await expect(latestOf('@nxgt/x')).rejects.toThrow(
			'the registry answered 404 for @nxgt/x',
		);
	});

	test('throws on an answer with no version', async () => {
		answer({});
		await expect(latestOf('@nxgt/x')).rejects.toThrow(
			"no version in @nxgt/x's latest",
		);
	});
});

describe('read', () => {
	test("reads this repository's manifests and bun.lock, trailing commas included", async () => {
		const { manifests: found, lockPackages } = await read(ROOT);
		const packages = tracked(found, lockPackages);
		expect(packages.map((one) => one.name)).toContain('@nxgt/openapi-codegen');
		expect(
			packages.find((one) => one.name === '@nxgt/openapi-codegen')?.dirs,
		).toEqual(['examples/hono-api']);
		for (const one of packages) expect(one.locked.length).toBeGreaterThan(0);
	});
});

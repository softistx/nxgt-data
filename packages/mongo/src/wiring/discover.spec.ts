import { afterEach, describe, expect, test } from 'bun:test';
import { rejectionMessage } from '../../test/rejection';
import { WiringError } from '../errors/wiring-error';
import { clearCollectionRegistry } from '../sync/registry';
import { discoverCollections } from './discover';

/** The package's own directory, whatever `bun test` was run from. */
const cwd = new URL('../..', import.meta.url).pathname;

const names = (definitions: { name: string }[]) =>
	definitions.map((definition) => definition.name).sort();

afterEach(() => {
	// Importing a model registers it: the registry is global.
	clearCollectionRegistry();
});

describe('discoverCollections', () => {
	test('reads every definition the files export', async () => {
		const found = await discoverCollections({
			glob: 'test/wiring/models/*.model.ts',
			cwd,
		});
		expect(names(found)).toEqual([
			'discovered_drafts',
			'discovered_posts',
			'discovered_users',
		]);
	});

	test('reads one export when it is named', async () => {
		const found = await discoverCollections({
			glob: 'test/wiring/models/*.model.ts',
			cwd,
			export: 'definition',
		});
		expect(names(found)).toEqual(['discovered_posts', 'discovered_users']);
	});

	test('reads only what the glob matches', async () => {
		const found = await discoverCollections({
			glob: 'test/wiring/models/*.model.ts',
			cwd,
		});
		expect(names(found)).not.toContain('discovered_notes');
	});

	test('finds nothing when nothing matches', async () => {
		expect(
			await discoverCollections({ glob: 'test/nowhere/*.ts', cwd }),
		).toEqual([]);
	});

	test('refuses two files on one server collection', async () => {
		await expect(
			await rejectionMessage(
				discoverCollections({
					glob: 'test/wiring/models-clash/*.model.ts',
					cwd,
				}),
			),
		).toContain('both define the collection "twice"');
	});

	test('refuses a named export that is no definition', async () => {
		await expect(
			await rejectionMessage(
				discoverCollections({
					glob: 'test/wiring/models-clash/none.ts',
					cwd,
					export: 'definition',
				}),
			),
		).toContain('exports no definition named "definition"');
	});

	test('refuses an empty glob', async () => {
		const error = await discoverCollections({ glob: '', cwd }).then(
			null,
			(reason: unknown) => reason,
		);
		expect(error).toHaveProperty(
			'message',
			expect.stringContaining('a glob is required'),
		);
		expect(error).toBeInstanceOf(WiringError);
		expect(error).toHaveProperty('code', 'DISCOVERY');
	});
});

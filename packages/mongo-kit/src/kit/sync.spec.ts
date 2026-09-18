import { describe, expect, test } from 'bun:test';
import { collections, events, useMongo } from '../../test/fixtures';
import { defineConfig } from '../config/define-config';
import { createKit } from './create-kit';

const { server, track } = useMongo('kit-sync');

const twoDatabases = () =>
	defineConfig({
		databases: {
			main: { uri: server.uri, collections },
			analytics: {
				uri: server.uri,
				database: 'kit-sync-analytics',
				collections: { events },
			},
		},
	});

describe('sync', () => {
	test('creates the collections the kit wires', async () => {
		const kit = track(
			await createKit(defineConfig({ uri: server.uri, collections })),
		);
		const reports = await kit.sync();
		expect(Object.keys(reports)).toEqual(['default']);
		expect(reports.default.map((report) => report.name).sort()).toEqual([
			'posts',
			'users',
		]);
		const names = (await server.db.listCollections().toArray()).map(
			(one) => one.name,
		);
		expect(names).toContain('users');
		expect(names).toContain('posts');
	});

	test('reports each database under its name', async () => {
		const kit = track(await createKit(twoDatabases()));
		const reports = await kit.sync();
		expect(Object.keys(reports)).toEqual(['main', 'analytics']);
		expect(reports.analytics.map((report) => report.name)).toEqual(['events']);
		const analytics = kit.clients.analytics.db('kit-sync-analytics');
		const names = (await analytics.listCollections().toArray()).map(
			(one) => one.name,
		);
		expect(names).toEqual(['events']);
		await analytics.dropDatabase();
	});

	test('changes nothing on a dry run', async () => {
		const kit = track(
			await createKit(defineConfig({ uri: server.uri, collections })),
		);
		const reports = await kit.sync({ dryRun: true });
		expect(reports.default).toHaveLength(2);
		const names = (await server.db.listCollections().toArray()).map(
			(one) => one.name,
		);
		expect(names).toEqual([]);
	});
});

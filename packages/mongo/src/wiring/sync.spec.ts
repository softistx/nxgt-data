import { describe, expect, test } from 'bun:test';
import { collections, events, useMongo } from '../../test/wiring';
import { defineMongo } from './config/define-mongo';
import { openMongo } from './open-mongo';

const { server, track } = useMongo('wiring-sync');

const twoDatabases = () =>
	defineMongo({
		databases: {
			main: { uri: server.uri, collections },
			analytics: {
				uri: server.uri,
				database: 'wiring-sync-analytics',
				collections: { events },
			},
		},
	});

describe('sync', () => {
	test('creates the collections the Mongo wires', async () => {
		const mongo = track(
			await openMongo(defineMongo({ uri: server.uri, collections })),
		);
		const reports = await mongo.sync();
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
		const mongo = track(await openMongo(twoDatabases()));
		const reports = await mongo.sync();
		expect(Object.keys(reports)).toEqual(['main', 'analytics']);
		expect(reports.analytics.map((report) => report.name)).toEqual(['events']);
		const analytics = mongo.clients.analytics.db('wiring-sync-analytics');
		const names = (await analytics.listCollections().toArray()).map(
			(one) => one.name,
		);
		expect(names).toEqual(['events']);
		await analytics.dropDatabase();
	});

	test('changes nothing on a dry run', async () => {
		const mongo = track(
			await openMongo(defineMongo({ uri: server.uri, collections })),
		);
		const reports = await mongo.sync({ dryRun: true });
		expect(reports.default).toHaveLength(2);
		const names = (await server.db.listCollections().toArray()).map(
			(one) => one.name,
		);
		expect(names).toEqual([]);
	});
});

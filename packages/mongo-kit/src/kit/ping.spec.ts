import { describe, expect, test } from 'bun:test';
import { MongoClient } from 'mongodb';
import { collections, events, useMongo } from '../../test/fixtures';
import { defineConfig } from '../config/define-config';
import { createKit } from './create-kit';

const { server, track } = useMongo('kit-ping');

describe('ping', () => {
	test('reports every database under its name, with its latency', async () => {
		const kit = track(
			await createKit(
				defineConfig({
					databases: {
						main: { uri: server.uri, collections },
						analytics: {
							uri: server.uri,
							database: 'kit-ping-analytics',
							collections: { events },
						},
					},
				}),
			),
		);
		const report = await kit.ping();
		expect(Object.keys(report)).toEqual(['main', 'analytics']);
		for (const result of Object.values(report)) {
			expect(result.ok).toBe(true);
			if (result.ok) expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		}
	});

	test('answers for a derived kit, which shares the databases', async () => {
		const kit = track(
			await createKit(defineConfig({ uri: server.uri, collections })),
		);
		const report = await kit.as({ id: 'x' } as never).ping();
		expect(report.default.ok).toBe(true);
	});

	test('a database the kit opened reports the driver’s own timeout', async () => {
		const kit = track(
			await createKit(defineConfig({ uri: server.uri, collections })),
		);
		await server.failNext(['ping'], {
			blockConnection: true,
			blockTimeMS: 1_500,
		});
		try {
			const started = performance.now();
			const report = await kit.ping({ timeoutMS: 300 });
			const took = performance.now() - started;
			expect(report.default.ok).toBe(false);
			if (!report.default.ok) {
				expect((report.default.error as Error).name).toBe(
					'MongoOperationTimeoutError',
				);
			}
			expect(took).toBeLessThan(1_200);
		} finally {
			await server.clearFailures();
		}
	});

	test('a client handed over unconnected is answered for within timeoutMS, without throwing', async () => {
		// A client the config hands over is never connected by the kit, so a
		// port nothing listens on reaches `ping` itself.
		const client = new MongoClient('mongodb://127.0.0.1:1/nowhere', {
			serverSelectionTimeoutMS: 5_000,
		});
		const kit = track(
			await createKit(defineConfig({ client, collections: { events } })),
		);
		const started = performance.now();
		const report = await kit.ping({ timeoutMS: 300 });
		const took = performance.now() - started;
		expect(report.default.ok).toBe(false);
		if (!report.default.ok) expect(report.default.error).toBeInstanceOf(Error);
		expect(took).toBeLessThan(2_000);
		await client.close();
	});
});

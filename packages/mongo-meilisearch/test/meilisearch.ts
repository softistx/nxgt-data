import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $ } from 'bun';
import { Meilisearch } from 'meilisearch';

// A copy of `@nxgt/meilisearch`'s `test/server.ts`: this package reaches no
// sibling's tests.

/**
 * The binary, from the repository's download script: it prints the path of
 * the cached one, and downloads it first when it is not there. Run rather
 * than imported, so this package's typecheck stays inside the package.
 */
async function ensureMeilisearch(): Promise<string> {
	const script = new URL('../../../scripts/meilisearch.ts', import.meta.url)
		.pathname;
	const path = (await $`bun run ${script}`.text()).trim();
	if (!path) throw new Error(`${script} printed no binary path`);
	return path;
}

/** A port nothing listens on, from the system: listen on 0, read it, close. */
async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.unref();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			server.close(() => resolve(port));
		});
	});
}

export interface TestServer {
	host: string;
	apiKey: string;
	client: Meilisearch;
	/** Deletes every index, so each test starts from none. */
	reset(): Promise<void>;
	stop(): Promise<void>;
}

/**
 * A real Meilisearch, one per spec file: the official binary
 * (`scripts/meilisearch.ts` downloads it), on a free port, with its database
 * in a temporary directory deleted by `stop`.
 */
export async function startMeilisearch(): Promise<TestServer> {
	const binary = await ensureMeilisearch();
	const port = await freePort();
	const dir = await mkdtemp(join(tmpdir(), 'nxgt-meilisearch-'));
	const apiKey = `test-master-key-${crypto.randomUUID()}`;
	const host = `http://127.0.0.1:${port}`;

	const server = Bun.spawn(
		[
			binary,
			'--http-addr',
			`127.0.0.1:${port}`,
			'--db-path',
			join(dir, 'data.ms'),
			'--dump-dir',
			join(dir, 'dumps'),
			'--snapshot-dir',
			join(dir, 'snapshots'),
			'--master-key',
			apiKey,
			'--env',
			'development',
			'--no-analytics',
			'--log-level',
			'WARN',
		],
		{ cwd: dir, stdout: 'ignore', stderr: 'pipe' },
	);

	const stop = async () => {
		server.kill();
		await server.exited;
		await rm(dir, { recursive: true, force: true });
	};

	const deadline = Date.now() + 30_000;
	for (;;) {
		if (server.exitCode !== null) {
			const stderr = await new Response(server.stderr).text();
			await rm(dir, { recursive: true, force: true });
			throw new Error(
				`Meilisearch exited with ${server.exitCode} before answering: ${stderr}`,
			);
		}
		const health = await fetch(`${host}/health`).catch(() => null);
		if (health?.ok) break;
		if (Date.now() > deadline) {
			await stop();
			throw new Error(`Meilisearch did not answer on ${host} within 30s`);
		}
		await Bun.sleep(50);
	}

	const client = new Meilisearch({ host, apiKey });
	return {
		host,
		apiKey,
		client,
		reset: async () => {
			const { results } = await client.getRawIndexes({ limit: 1000 });
			await Promise.all(
				results.map((index) => client.deleteIndex(index.uid).waitTask()),
			);
		},
		stop,
	};
}

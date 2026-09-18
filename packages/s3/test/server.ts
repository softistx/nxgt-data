import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { $, S3Client, type Subprocess } from 'bun';

/**
 * The binary, from the repository's download script: it prints the path of
 * the cached one, and downloads it first when it is not there. Run rather
 * than imported, so this package's typecheck stays inside the package — the
 * same way `@nxgt/meilisearch`'s server does it.
 */
async function ensureSeaweedfs(): Promise<string> {
	const script = new URL('../../../scripts/seaweedfs.ts', import.meta.url)
		.pathname;
	const path = (await $`bun run ${script}`.text()).trim();
	if (!path) throw new Error(`${script} printed no binary path`);
	return path;
}

/** The credentials the specs sign with. Local only, and never a real key. */
export const ACCESS_KEY_ID = 'nxgt-test-key';
export const SECRET_ACCESS_KEY = 'nxgt-test-secret';

export interface TestServer {
	endpoint: string;
	/** Options ready for `bindBucket`, pointing at this server. */
	options: {
		endpoint: string;
		accessKeyId: string;
		secretAccessKey: string;
		region: string;
		virtualHostedStyle: false;
	};
	/** A client of this server, the specs' own. */
	client: S3Client;
	/** Empties a bucket, so each test starts from nothing. */
	reset(bucket: string): Promise<void>;
	stop(): Promise<void>;
}

/** Whether nothing listens on `port`, and nothing can be bound there. */
async function isFree(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const server = createServer();
		server.unref();
		server.on('error', () => resolve(false));
		server.listen(port, '127.0.0.1', () => {
			server.close(() => resolve(true));
		});
	});
}

/**
 * Eight consecutive free ports: one per service, plus one gRPC port each.
 *
 * Each SeaweedFS service listens twice, and left alone it derives the gRPC
 * port by adding 10000 — the filer even names a unix socket after it,
 * `/tmp/seaweedfs-filer-grpc-<port>.sock`. Measured, a run whose filer landed
 * on 42937 died with its gRPC socket missing, because something already held
 * 52937. `weed server` takes `-master.port.grpc` and the three others, so
 * every port it binds is named here and verified here rather than hoped for.
 */
const PORTS = 8;

async function freePorts(): Promise<number[]> {
	for (let attempt = 0; attempt < 50; attempt++) {
		// Below the ephemeral range the kernel hands out, so nothing is taken
		// from under the server mid-run.
		const base = 20_000 + Math.floor(Math.random() * 10_000);
		const wanted = Array.from({ length: PORTS }, (_, i) => base + i);
		const free = await Promise.all(wanted.map(isFree));
		if (free.every(Boolean)) return wanted;
	}
	throw new Error(`no free block of ${PORTS} consecutive ports`);
}

/**
 * A real S3 API, one per spec file: SeaweedFS's own gateway, started by
 * `weed server -s3`. Not MinIO — it is archived and publishes no binary; see
 * `scripts/seaweedfs.ts`. Starting it takes about five seconds once the
 * binary is cached, which is why `test/fixtures.ts` gives `beforeAll` 120 s.
 */
export async function startS3(buckets: string[] = []): Promise<TestServer> {
	const binary = await ensureSeaweedfs();
	const dir = await mkdtemp(join(tmpdir(), 'nxgt-s3-'));
	const ports = await freePorts();
	const [s3Port, master, volume, filer] = ports as [
		number,
		number,
		number,
		number,
	];
	const [s3Grpc, masterGrpc, volumeGrpc, filerGrpc] = ports.slice(4) as [
		number,
		number,
		number,
		number,
	];

	// Without an identities file there are no credentials, and every signed
	// request is refused.
	// `weed` refuses to start when `-dir` is not there — it does not create
	// it, and says so only on stderr, which is why that is captured below.
	const data = join(dir, 'data');
	await mkdir(data, { recursive: true });

	const config = join(dir, 's3.json');
	await Bun.write(
		config,
		JSON.stringify({
			identities: [
				{
					name: 'test',
					credentials: [
						{ accessKey: ACCESS_KEY_ID, secretKey: SECRET_ACCESS_KEY },
					],
					actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
				},
			],
		}),
	);

	// Its log goes to a file, not a pipe: SeaweedFS is chatty enough to fill
	// the 64 KB pipe buffer in well under a minute, and a pipe nobody drains
	// blocks the process that writes to it — measured, that is a server that
	// starts, serves briefly and then hangs.
	const logPath = join(dir, 'weed.log');
	const log = Bun.file(logPath);

	const process: Subprocess = Bun.spawn(
		[
			binary,
			'server',
			`-dir=${data}`,
			'-s3',
			`-s3.port=${s3Port}`,
			`-s3.config=${config}`,
			// 4.47 starts two more listeners beside the S3 one, each on a
			// **fixed** port: an Iceberg REST Catalog on 8181 and a Lance
			// Namespace on 9101. Either one collides with a second spec file
			// or a leftover server and kills the whole process —
			// `bind: address already in use`, fatal, whatever the ports above
			// were. Nothing here uses them.
			'-s3.port.iceberg=0',
			'-s3.port.lance=0',
			// Each bucket is a *collection*, and a collection needs a volume of
			// its own. The defaults are a production shape — 8 volumes of
			// 30 GB — and on a normal disk the master then finds nothing it
			// can allocate: `No writable volumes and no free volumes left`.
			// Small volumes, and enough of them for a spec file's buckets.
			'-master.volumeSizeLimitMB=64',
			'-volume.max=100',
			`-master.port=${master}`,
			`-volume.port=${volume}`,
			`-filer.port=${filer}`,
			`-s3.port.grpc=${s3Grpc}`,
			`-master.port.grpc=${masterGrpc}`,
			`-volume.port.grpc=${volumeGrpc}`,
			`-filer.port.grpc=${filerGrpc}`,
			'-ip=127.0.0.1',
		],
		{ stdout: 'ignore', stderr: log },
	);

	const endpoint = `http://127.0.0.1:${s3Port}`;
	const options = {
		endpoint,
		accessKeyId: ACCESS_KEY_ID,
		secretAccessKey: SECRET_ACCESS_KEY,
		region: 'us-east-1',
		virtualHostedStyle: false as const,
	};
	const client = new S3Client({ ...options, bucket: 'health' });

	// The gateway answers well before the filer behind it has registered, and
	// a write that lands in between fails with `InternalError`. Writing is the
	// only thing that proves it is ready — and it has to be **every** bucket,
	// because the readiness is per bucket: measured, a write to the first
	// bucket succeeds while a write to the second still fails for a moment.
	// SeaweedFS creates a bucket on that first write; `Bun.S3Client` has no
	// `createBucket`, and `presign('')` is refused (`ERR_S3_INVALID_PATH`),
	// so there is nothing more direct to call.
	const deadline = Date.now() + 90_000;
	for (const bucket of ['health', ...buckets]) {
		const scoped = new S3Client({ ...options, bucket });
		for (;;) {
			const ok = await scoped
				.write('.nxgt-ready', 'ok')
				.then(() => true)
				.catch(() => false);
			if (ok) break;
			if (Date.now() > deadline) {
				// Its own words, or the failure is unreadable: `weed` reports a
				// bad `-dir`, a taken port and a refused config all on stderr.
				process.kill();
				const said = await Bun.file(logPath)
					.text()
					.catch(() => '');
				const interesting = said
					.split('\n')
					.filter((line) => /error|fatal|^F\d|refus|denied/i.test(line));
				throw new Error(
					`SeaweedFS did not serve S3 on ${endpoint} in 90s (bucket ` +
						`"${bucket}"). Its log, ${logPath}, says:\n` +
						`${(interesting.length > 0 ? interesting : said.split('\n'))
							.slice(-8)
							.join('\n')}`,
				);
			}
			await Bun.sleep(250);
		}
		await scoped.delete('.nxgt-ready').catch(() => undefined);
	}

	return {
		endpoint,
		options,
		client,
		reset: async (bucket) => {
			const scoped = new S3Client({ ...options, bucket });
			const listed = await scoped.list({ maxKeys: 1000 }).catch(() => null);
			for (const found of listed?.contents ?? []) {
				if (found.key) await scoped.delete(found.key).catch(() => undefined);
			}
		},
		stop: async () => {
			process.kill();
			await process.exited;
			await rm(dir, { recursive: true, force: true });
			// `weed` names a unix socket in the system's temp directory after
			// each port it binds, and leaves them behind. They do not stop a
			// later run — it unlinks and rebinds — but a long-lived CI runner
			// would otherwise collect one per port per spec run.
			await Promise.all(
				['s3', 'master', 'volume', 'filer'].flatMap((service, index) => [
					rm(join(tmpdir(), `seaweedfs-${service}-${ports[index]}.sock`), {
						force: true,
					}),
					rm(
						join(
							tmpdir(),
							`seaweedfs-${service}-grpc-${ports[index + 4]}.sock`,
						),
						{ force: true },
					),
				]),
			);
		},
	};
}

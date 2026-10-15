import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';
import { freePorts } from './ports';
import { createBucketOn, emptyBucket, type ServerAddress } from './ready';
import { type SeaweedfsOptions, seaweedfsBinary } from './seaweedfs';

/** The credentials the server signs with. Local only, and never a real key. */
const ACCESS_KEY_ID = 'nxgt-test-key';
const SECRET_ACCESS_KEY = 'nxgt-test-secret';

export type TestS3Options = SeaweedfsOptions;

export interface TestS3 {
	endpoint: string;
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
	/** Options ready for `bindBucket`, pointing at this server. */
	options: ServerAddress;
	/** Creates `name` and resolves once it takes writes. */
	createBucket(name: string): Promise<void>;
	/** Empties a bucket, so each test starts from nothing. */
	reset(bucket: string): Promise<void>;
	/** Kills the server and removes its files. Calling it again does nothing. */
	stop(): Promise<void>;
}

/**
 * `weed server -s3` on free ports. Each flag is a measured trap; see
 * AGENTS.md, Tests.
 */
function spawnWeed(
	binary: string,
	data: string,
	config: string,
	ports: number[],
	log: ReturnType<typeof Bun.file>,
): Subprocess {
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
	return Bun.spawn(
		[
			binary,
			'server',
			`-dir=${data}`,
			'-s3',
			`-s3.port=${s3Port}`,
			`-s3.config=${config}`,
			// 4.47 starts two more listeners beside the S3 one, each on a
			// **fixed** port: an Iceberg REST Catalog on 8181 and a Lance
			// Namespace on 9101. Either one collides with a second server or a
			// leftover one and kills the whole process — `bind: address already
			// in use`, fatal, whatever the ports above were. Nothing uses them.
			'-s3.port.iceberg=0',
			'-s3.port.lance=0',
			// Each bucket is a *collection*, and a collection needs a volume of
			// its own. The defaults are a production shape — 8 volumes of 30 GB —
			// and on a normal disk the master then finds nothing it can
			// allocate: `No writable volumes and no free volumes left`. Small
			// volumes, and enough of them for a suite's buckets.
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
}

/** The unix sockets `weed` leaves in the temp directory, one per port. */
function socketsOf(ports: number[]): string[] {
	return ['s3', 'master', 'volume', 'filer'].flatMap((service, index) => [
		join(tmpdir(), `seaweedfs-${service}-${ports[index]}.sock`),
		join(tmpdir(), `seaweedfs-${service}-grpc-${ports[index + 4]}.sock`),
	]);
}

/**
 * A real S3 API for a suite: SeaweedFS's own gateway, started by
 * `weed server -s3` on free ports, with no Docker. Starting it takes about
 * five seconds once the binary is cached; the first run downloads it.
 *
 * A server nobody stops is killed when the process exits.
 */
export async function startTestS3(
	options: TestS3Options = {},
): Promise<TestS3> {
	const binary = await seaweedfsBinary(options);
	const dir = await mkdtemp(join(tmpdir(), 'nxgt-s3-'));
	const ports = await freePorts();

	// `weed` refuses to start when `-dir` is not there — it does not create
	// it, and says so only on stderr, which is why that is captured below.
	const data = join(dir, 'data');
	await mkdir(data, { recursive: true });
	// Without an identities file there are no credentials, and every signed
	// request is refused.
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
	const child = spawnWeed(binary, data, config, ports, Bun.file(logPath));
	const killOnExit = () => child.kill('SIGKILL');
	process.on('exit', killOnExit);

	const endpoint = `http://127.0.0.1:${ports[0]}`;
	const address: ServerAddress = {
		endpoint,
		accessKeyId: ACCESS_KEY_ID,
		secretAccessKey: SECRET_ACCESS_KEY,
		region: 'us-east-1',
		virtualHostedStyle: false,
	};

	let stopped: Promise<void> | undefined;
	const stop = (): Promise<void> => {
		stopped ??= (async () => {
			process.off('exit', killOnExit);
			// `SIGKILL`, not the default `SIGTERM`. Measured on SeaweedFS 4.47:
			// `weed server` takes **20 s** to exit on either SIGTERM or SIGINT —
			// 20078 / 20024 ms and 20015 / 20102 ms over two runs each — and
			// **11 ms** on SIGKILL. That is a fixed shutdown grace period, not a
			// flush: the directory it writes into is removed on the next line.
			child.kill('SIGKILL');
			await child.exited;
			await rm(dir, { recursive: true, force: true });
			// `weed` leaves a unix socket per port it bound; a long-lived CI
			// runner would otherwise collect them.
			await Promise.all(
				socketsOf(ports).map((socket) => rm(socket, { force: true })),
			);
		})();
		return stopped;
	};

	try {
		await createBucketOn(address, 'health', logPath);
	} catch (error) {
		await stop();
		throw error;
	}

	return {
		endpoint,
		accessKeyId: ACCESS_KEY_ID,
		secretAccessKey: SECRET_ACCESS_KEY,
		region: address.region,
		options: address,
		createBucket: (name) => createBucketOn(address, name, logPath),
		reset: (bucket) => emptyBucket(address, bucket),
		stop,
	};
}

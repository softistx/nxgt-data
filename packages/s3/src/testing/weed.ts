import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Subprocess } from 'bun';

/** The credentials the server signs with. Local only, and never a real key. */
export const ACCESS_KEY_ID = 'nxgt-test-key';
export const SECRET_ACCESS_KEY = 'nxgt-test-secret';

/**
 * Without an identities file there are no credentials, and every signed
 * request is refused.
 */
export function identities(): string {
	return JSON.stringify({
		identities: [
			{
				name: 'test',
				credentials: [
					{ accessKey: ACCESS_KEY_ID, secretKey: SECRET_ACCESS_KEY },
				],
				actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
			},
		],
	});
}

/**
 * `weed server -s3` on free ports. Each flag is a measured trap; see
 * AGENTS.md, Tests.
 */
export function spawnWeed(
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
	const child = Bun.spawn(
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
	// A server nobody stopped must not keep the process alive: `reaper.ts`
	// kills it when the process ends.
	child.unref();
	return child;
}

/** The unix sockets `weed` leaves in the temp directory, one per port. */
export function socketsOf(ports: number[]): string[] {
	return ['s3', 'master', 'volume', 'filer'].flatMap((service, index) => [
		join(tmpdir(), `seaweedfs-${service}-${ports[index]}.sock`),
		join(tmpdir(), `seaweedfs-${service}-grpc-${ports[index + 4]}.sock`),
	]);
}

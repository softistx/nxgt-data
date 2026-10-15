import { createServer } from 'node:net';

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
 * every port it binds is named and verified rather than hoped for.
 */
export const PORTS = 8;

export async function freePorts(): Promise<number[]> {
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

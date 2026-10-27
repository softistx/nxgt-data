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

/**
 * Blocks handed out by this process and not yet released. Probing alone is a
 * check-then-use race: two servers started together both probe before either
 * binds, so both can be told the same, or an overlapping, block (#277: the
 * second master died with `bind: address already in use` on a gRPC port).
 */
const claimed = new Set<number>();

/** Gives a block back once its server is stopped. */
export function releasePorts(ports: number[]): void {
	for (const port of ports) claimed.delete(port);
}

export async function freePorts(): Promise<number[]> {
	for (let attempt = 0; attempt < 50; attempt++) {
		// Below the ephemeral range the kernel hands out, so nothing is taken
		// from under the server mid-run.
		const base = 20_000 + Math.floor(Math.random() * 10_000);
		const wanted = Array.from({ length: PORTS }, (_, i) => base + i);
		if (wanted.some((port) => claimed.has(port))) continue;
		// Claimed before the first await, so a concurrent call sees it.
		for (const port of wanted) claimed.add(port);
		const free = await Promise.all(wanted.map(isFree));
		if (free.every(Boolean)) return wanted;
		releasePorts(wanted);
	}
	throw new Error(`no free block of ${PORTS} consecutive ports`);
}

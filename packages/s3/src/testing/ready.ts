import { S3Client } from 'bun';

export interface ServerAddress {
	endpoint: string;
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
	virtualHostedStyle: false;
}

export interface ServerHandle {
	logPath: string;
	/** Settles when the server process ends. */
	exited: Promise<unknown>;
}

/** The interesting lines of the server's own log, or its last ones. */
async function logTail(logPath: string): Promise<string> {
	// Its own words, or the failure is unreadable: `weed` reports a bad
	// `-dir`, a taken port and a refused config all on stderr.
	const said = await Bun.file(logPath)
		.text()
		.catch(() => '');
	const interesting = said
		.split('\n')
		.filter((line) => /error|fatal|^F\d|refus|denied/i.test(line));
	return (interesting.length > 0 ? interesting : said.split('\n'))
		.slice(-8)
		.join('\n');
}

/**
 * Creates `bucket` and waits until it takes writes.
 *
 * The gateway answers well before the filer behind it has registered, and a
 * write that lands in between fails with `InternalError`. Writing is the only
 * thing that proves it is ready — and it has to be **every** bucket, because
 * the readiness is per bucket: measured, a write to the first bucket succeeds
 * while a write to the second still fails for a moment. SeaweedFS creates a
 * bucket on that first write; `Bun.S3Client` has no `createBucket`, and
 * `presign('')` is refused (`ERR_S3_INVALID_PATH`), so there is nothing more
 * direct to call.
 *
 * A server that dies while this waits is reported at once, with its log.
 */
export async function createBucketOn(
	address: ServerAddress,
	bucket: string,
	server: ServerHandle,
	timeoutMs = 90_000,
): Promise<void> {
	const scoped = new S3Client({ ...address, bucket });
	const deadline = Date.now() + timeoutMs;
	let dead = false;
	void server.exited.then(() => {
		dead = true;
	});
	for (;;) {
		const ok = await scoped
			.write('.nxgt-ready', 'ok')
			.then(() => true)
			.catch(() => false);
		if (ok) break;
		const failed = dead
			? 'SeaweedFS exited before it served S3'
			: Date.now() > deadline
				? `SeaweedFS did not serve S3 on ${address.endpoint} in ${Math.round(timeoutMs / 1000)}s`
				: undefined;
		if (failed) {
			throw new Error(
				`${failed} (bucket "${bucket}"). Its log, ${server.logPath}, says:\n` +
					(await logTail(server.logPath)),
			);
		}
		await Bun.sleep(250);
	}
	await scoped.delete('.nxgt-ready').catch(() => undefined);
}

/**
 * Deletes every object of `bucket`, so a test starts from nothing. A failure
 * of the listing or of a delete (a bucket that was never created included) is
 * thrown, not hidden: a test must not run on objects a reset missed.
 */
export async function emptyBucket(
	address: ServerAddress,
	bucket: string,
): Promise<void> {
	const scoped = new S3Client({ ...address, bucket });
	for (let page = 0; page < 1000; page++) {
		const listed = await scoped.list({ maxKeys: 1000 });
		const keys = (listed.contents ?? []).flatMap((found) =>
			found.key ? [found.key] : [],
		);
		await Promise.all(keys.map((key) => scoped.delete(key)));
		if (keys.length === 0 || !listed.isTruncated) return;
	}
}

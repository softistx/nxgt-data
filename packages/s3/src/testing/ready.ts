import { S3Client } from 'bun';

export interface ServerAddress {
	endpoint: string;
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
	virtualHostedStyle: false;
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
 */
export async function createBucketOn(
	address: ServerAddress,
	bucket: string,
	logPath: string,
	timeoutMs = 90_000,
): Promise<void> {
	const scoped = new S3Client({ ...address, bucket });
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const ok = await scoped
			.write('.nxgt-ready', 'ok')
			.then(() => true)
			.catch(() => false);
		if (ok) break;
		if (Date.now() > deadline) {
			// Its own words, or the failure is unreadable: `weed` reports a bad
			// `-dir`, a taken port and a refused config all on stderr.
			const said = await Bun.file(logPath)
				.text()
				.catch(() => '');
			const interesting = said
				.split('\n')
				.filter((line) => /error|fatal|^F\d|refus|denied/i.test(line));
			throw new Error(
				`SeaweedFS did not serve S3 on ${address.endpoint} in ` +
					`${Math.round(timeoutMs / 1000)}s (bucket "${bucket}"). Its log, ` +
					`${logPath}, says:\n` +
					`${(interesting.length > 0 ? interesting : said.split('\n'))
						.slice(-8)
						.join('\n')}`,
			);
		}
		await Bun.sleep(250);
	}
	await scoped.delete('.nxgt-ready').catch(() => undefined);
}

/** Deletes every object of `bucket`, so a test starts from nothing. */
export async function emptyBucket(
	address: ServerAddress,
	bucket: string,
): Promise<void> {
	const scoped = new S3Client({ ...address, bucket });
	for (let page = 0; page < 1000; page++) {
		const listed = await scoped.list({ maxKeys: 1000 }).catch(() => null);
		const keys = (listed?.contents ?? []).flatMap((found) =>
			found.key ? [found.key] : [],
		);
		if (keys.length === 0) return;
		await Promise.all(
			keys.map((key) => scoped.delete(key).catch(() => undefined)),
		);
		if (!listed?.isTruncated) return;
	}
}

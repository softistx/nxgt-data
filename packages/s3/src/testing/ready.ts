import { S3Client } from 'bun';
import { checkTimeout } from '../bucket/operations/deadline';
import { S3Error } from '../errors/s3-error';

/** The option both `createBucket` and `reset` take. */
export interface DeadlineOptions {
	/**
	 * A deadline in whole milliseconds, 1 or more. A call that gets no answer
	 * in time rejects with `S3Error` `TIMEOUT`. Without it, `reset` waits as
	 * long as the server does and `createBucket` keeps its 90 s readiness wait.
	 */
	timeoutMs?: number | undefined;
}

/**
 * Settles with `run`, or rejects with `S3Error` `TIMEOUT` once `timeoutMs`
 * has passed. The timer is cleared whichever way it ends.
 */
async function within<T>(
	timeoutMs: number | undefined,
	bucket: string,
	call: string,
	run: () => Promise<T>,
): Promise<T> {
	if (timeoutMs === undefined) return run();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const late = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() =>
				reject(
					new S3Error(
						'TIMEOUT',
						bucket,
						`${call} on "${bucket}": the test S3 server gave no answer in ${timeoutMs}ms; it is stuck`,
					),
				),
			timeoutMs,
		);
	});
	const work = run();
	work.catch(() => undefined);
	try {
		return await Promise.race([work, late]);
	} finally {
		clearTimeout(timer);
	}
}

export interface ServerAddress {
	endpoint: string;
	accessKeyId: string;
	secretAccessKey: string;
	region: string;
	virtualHostedStyle: false;
}

/**
 * S3's rules for a bucket name, which SeaweedFS enforces by refusing every
 * write: without this check `createBucket` would retry for the whole timeout.
 */
export function checkBucketName(name: string): void {
	if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(name)) {
		throw new TypeError(
			`createBucket: "${name.slice(0, 80)}" is not a bucket name S3 accepts: ` +
				'3 to 63 characters, lowercase letters, digits, dots and hyphens, ' +
				'starting and ending with a letter or digit',
		);
	}
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
	options: DeadlineOptions = {},
): Promise<void> {
	checkBucketName(bucket);
	const own = checkTimeout(bucket, options.timeoutMs, 'createBucket');
	const timeoutMs = own ?? 90_000;
	const scoped = new S3Client({ ...address, bucket });
	const deadline = Date.now() + timeoutMs;
	let dead = false;
	void server.exited.then(() => {
		dead = true;
	});
	for (;;) {
		const ok = await within(
			own === undefined ? undefined : Math.max(1, deadline - Date.now()),
			bucket,
			'createBucket',
			() =>
				scoped
					.write('.nxgt-ready', 'ok')
					.then(() => true)
					.catch(() => false),
		);
		if (ok) break;
		if (own !== undefined && !dead && Date.now() > deadline) {
			throw new S3Error(
				'TIMEOUT',
				bucket,
				`createBucket on "${bucket}": the test S3 server did not take a write in ${own}ms. Its log, ${server.logPath}, says:\n` +
					(await logTail(server.logPath)),
			);
		}
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
 * thrown, not hidden: a test must not run on objects a reset missed. With
 * `timeoutMs`, each list and delete round has that deadline (`TIMEOUT`).
 */
export async function emptyBucket(
	address: ServerAddress,
	bucket: string,
	options: DeadlineOptions = {},
): Promise<void> {
	const own = checkTimeout(bucket, options.timeoutMs, 'reset');
	const scoped = new S3Client({ ...address, bucket });
	for (let page = 0; page < 1000; page++) {
		const listed = await within(own, bucket, 'reset (list)', () =>
			scoped.list({ maxKeys: 1000 }),
		);
		const keys = (listed.contents ?? []).flatMap((found) =>
			found.key ? [found.key] : [],
		);
		await within(own, bucket, 'reset (delete)', () =>
			Promise.all(keys.map((key) => scoped.delete(key))),
		);
		if (keys.length === 0 || !listed.isTruncated) return;
	}
}

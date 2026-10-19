/** A job a claim handed out: the stored payload, as JSON, and the token that proves it is held. */
export type ClaimedJob = {
	id: string;
	/** The stored JSON; the caller parses it through the schema. */
	data: string;
	/** This run, counting from 1: the claim already counted it. */
	attempt: number;
	attempts: number;
	/** 32 lowercase hex; every settle and renew must present it. */
	token: string;
	/** How long this job's run may take, in ms; `undefined` for no limit. */
	timeout: number | undefined;
};

/** A schedule a claim found due: the client computes its next occurrence and fires it. */
export type DueSchedule = {
	id: string;
	kind: 'cron' | 'every';
	/** The cron text, or the interval in ms as text. */
	spec: string;
	/** The zone of a cron; `''` for an `every`. */
	timezone: string;
	/** The occurrence's ms, the schedule's score. */
	due: number;
};

/** What the claim part of any script answers. */
export type ClaimReply = {
	jobs: ClaimedJob[];
	/** Jobs whose lease lapsed and were taken back (or failed, when spent). */
	stalled: string[];
	/** Jobs found in a shape this package could not have written, now `failed`. */
	failedInvalid: string[];
	/** Ms until the first delayed job is due, or `-1` when none is waiting. */
	next: number;
	/** Up to 20 schedules whose time has come, earliest first. */
	due: DueSchedule[];
};

/*
 * Redis replies reach here as the RESP3 values Bun decodes: numbers as
 * numbers, nested arrays as arrays. A reply that is not exactly the shape
 * the script documents is refused rather than coerced, so a script and its
 * parser that drift apart fail loudly, in a test, not as a lost job.
 */

function refuse(what: string): never {
	throw new Error(`queue script reply not recognised: ${what}`);
}

function array(value: unknown, what: string): unknown[] {
	if (!Array.isArray(value)) refuse(`${what} is not an array`);
	return value;
}

function text(value: unknown, what: string): string {
	if (typeof value !== 'string') refuse(`${what} is not a string`);
	return value;
}

function whole(value: unknown, what: string): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		refuse(`${what} is not a number`);
	}
	return value;
}

function timeoutOf(ms: number): number | undefined {
	return ms === -1 ? undefined : ms;
}

function texts(value: unknown, what: string): string[] {
	return array(value, what).map((item) => text(item, what));
}

/**
 * Reads the claim part of a reply: `{jobs, stalled, invalid, next, due}` found in
 * `raw` from `from` on. Each job is `{id, data, attempt, attempts, token}`.
 */
export function parseClaim(raw: unknown[], from: number): ClaimReply {
	const jobs = array(raw[from], 'jobs').map((entry): ClaimedJob => {
		const job = array(entry, 'job');
		return {
			id: text(job[0], 'job id'),
			data: text(job[1], 'job data'),
			attempt: whole(job[2], 'job attempt'),
			attempts: whole(job[3], 'job attempts'),
			token: text(job[4], 'job token'),
			// The script answers -1 for a job without a limit: a Lua table has no nil.
			timeout: timeoutOf(whole(job[5], 'job timeout')),
		};
	});
	const due = array(raw[from + 4], 'due').map((entry): DueSchedule => {
		const row = array(entry, 'due schedule');
		const kind = text(row[1], 'schedule kind');
		if (kind !== 'cron' && kind !== 'every') refuse('schedule kind is unknown');
		return {
			id: text(row[0], 'schedule id'),
			kind,
			spec: text(row[2], 'schedule spec'),
			timezone: text(row[3], 'schedule timezone'),
			due: whole(row[4], 'schedule due'),
		};
	});
	return {
		jobs,
		stalled: texts(raw[from + 1], 'stalled'),
		failedInvalid: texts(raw[from + 2], 'invalid'),
		next: whole(raw[from + 3], 'next'),
		due,
	};
}

/** A claim's whole reply. */
export function parseClaimReply(raw: unknown): ClaimReply {
	return parseClaim(array(raw, 'reply'), 0);
}

/** `complete`'s reply: `{settled, jobs, stalled, invalid, next}`. */
export function parseComplete(raw: unknown): ClaimReply & { settled: boolean } {
	const parts = array(raw, 'reply');
	return { settled: whole(parts[0], 'settled') === 1, ...parseClaim(parts, 1) };
}

/** `fail`'s reply: `{settled, final, jobs, stalled, invalid, next}`. */
export function parseFail(
	raw: unknown,
): ClaimReply & { settled: boolean; final: boolean } {
	const parts = array(raw, 'reply');
	return {
		settled: whole(parts[0], 'settled') === 1,
		final: whole(parts[1], 'final') === 1,
		...parseClaim(parts, 2),
	};
}

/** `renew`'s reply: the ids that lost their token. */
export function parseLost(raw: unknown): string[] {
	return texts(raw, 'lost ids');
}

/** `RELEASE`'s reply: the ids given back. */
export function parseReleased(raw: unknown): string[] {
	return texts(raw, 'released ids');
}

/** What `stepBegin` answers. */
export type StepBegin =
	| { stored: true; json: string }
	| { stored: false }
	| { lost: true };

/** `STEP_BEGIN`'s reply: `{1, json}` stored, `{0}` run it, `{-1}` lost. */
export function parseStepBegin(raw: unknown): StepBegin {
	const parts = array(raw, 'reply');
	const code = whole(parts[0], 'step code');
	if (code === -1 && parts.length === 1) return { lost: true };
	if (code === 0 && parts.length === 1) return { stored: false };
	if (code === 1 && parts.length === 2) {
		return { stored: true, json: text(parts[1], 'step json') };
	}
	return refuse(`step reply of ${parts.length} parts with code ${code}`);
}

/** `STEP_COMMIT`'s reply: exactly 1 (written) or 0 (lost). */
export function parseStepCommit(raw: unknown): boolean {
	if (raw === 1) return true;
	if (raw === 0) return false;
	return refuse(`step commit reply ${typeof raw}`);
}

/** One job's part of `ADD`'s reply, as the handle reads it. */
export type AddReply = {
	/** `true` when nothing was added: the id existed, or a dedupe key held a job. */
	deduplicated: boolean;
	/** The id of the job a dedupe key named; `undefined` otherwise (the id is the given one). */
	held: string | undefined;
};

/**
 * `ADD`'s reply for `jobs` jobs: per job `0` (added), `1` (the given id
 * existed) or the id string of the job a debounce or throttle key holds.
 * Shapes only; an id is any non-empty string.
 */
export function parseAddReply(raw: unknown, jobs: number): AddReply[] {
	const parts = array(raw, 'reply');
	if (parts.length !== jobs) {
		refuse(`add reply of ${parts.length} parts for ${jobs} jobs`);
	}
	return parts.map((part): AddReply => {
		if (part === 0) return { deduplicated: false, held: undefined };
		if (part === 1) return { deduplicated: true, held: undefined };
		if (typeof part === 'string' && part !== '') {
			return { deduplicated: true, held: part };
		}
		return refuse(`add reply part is ${typeof part}`);
	});
}

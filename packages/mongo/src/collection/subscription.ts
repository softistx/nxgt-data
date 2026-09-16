import { AsyncLocalStorage } from 'node:async_hooks';
import type { ChangeStream, Document } from 'mongodb';
import { toDataError } from '../errors/to-data-error';
import type {
	ChangeHandler,
	ChangeOptions,
	ChangeSubscription,
	CloseReason,
} from './change-types';
import { pipelineOf, toChange, watchOptionsOf } from './changes';
import type { CollectionContext } from './context';

/**
 * Server errors a new stream would only meet again: the caller's own input
 * (2 BadValue, 9 FailedToParse, 14 TypeMismatch, 40647 — a bad filter or
 * token, measured), a
 * history the server no longer has (280, 286), a user who may not read (13,
 * 18). Everything else the driver gave up on is worth another try from the
 * last token — measured, without the resumable label the driver gives up even
 * on 91 ShutdownInProgress, and closes its stream with its token intact.
 */
const FATAL = new Set([2, 9, 13, 14, 18, 280, 286, 40647]);

function worthRetrying(error: unknown): boolean {
	const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
	if (typeof name !== 'string' || !name.startsWith('Mongo')) return false;
	if (name === 'MongoAPIError') return false;
	return typeof code !== 'number' || !FATAL.has(code);
}

/**
 * The end of a subscription by an error of the caller's code: a handler that
 * threw with no `onError`, or an `onError` that threw. `told` says whether
 * `onError` has already seen it, so that it is not handed the same error
 * twice.
 */
class Stopped {
	constructor(
		readonly cause: unknown,
		readonly told: boolean,
	) {}
}

/** Where one subscription is. Data only, like the collection's context. */
interface State {
	closing: boolean;
	stream: ChangeStream | undefined;
	/** Where to reopen from. */
	token: unknown;
	/** The token of the last change handled: what `resumeToken` shows. */
	handled: unknown;
	/** Failed attempts since the last read that worked. */
	failures: number;
}

/**
 * The subscription whose handler is running, if any: how `close()` knows it
 * was called from inside one, where waiting for the handler to finish would
 * wait for itself.
 */
const delivering = new AsyncLocalStorage<State>();

/** Waits before another attempt, or less if the subscription is closed. */
function pause(attempt: number, signal: AbortSignal): Promise<void> {
	const ms = Math.min(100 * 2 ** (attempt - 1), 10_000);
	return new Promise((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			'abort',
			() => {
				clearTimeout(timer);
				resolve();
			},
			{ once: true },
		);
	});
}

/** Hands one change to the handler, or its error to `onError`. */
async function deliver(
	state: State,
	handler: ChangeHandler<never>,
	change: Document,
	options: ChangeOptions<never>,
): Promise<void> {
	try {
		await delivering.run(state, () => handler(change as never));
	} catch (error) {
		if (!options.onError) throw new Stopped(error, false);
		try {
			const onError = options.onError;
			await delivering.run(state, () => onError(error, change as never));
		} catch (again) {
			throw new Stopped(again, true);
		}
	}
}

/** Reads one stream until it ends, one change at a time. */
async function drain(
	ctx: CollectionContext,
	stream: ChangeStream,
	handler: ChangeHandler<never>,
	options: ChangeOptions<never>,
	state: State,
	markReady: () => void,
): Promise<CloseReason> {
	while (!state.closing) {
		// `tryNext` answers `null` after a server-side wait with nothing new;
		// the first call is also what opens the stream.
		const event = await stream.tryNext();
		// A read that worked, change or not, ends a run of failures.
		state.failures = 0;
		markReady();
		if (!event) continue;
		if (event.operationType === 'invalidate') return 'invalidated';
		const change = toChange(ctx, event as Document, options);
		if (change) await deliver(state, handler, change, options);
		state.handled = event._id;
		state.token = event._id;
	}
	return 'closed';
}

interface Listening {
	readonly pipeline: Document[];
	readonly retries: number;
	readonly signal: AbortSignal;
	readonly markReady: () => void;
}

/** Opens streams until one ends for good, reopening from the last token. */
async function listen(
	ctx: CollectionContext,
	handler: ChangeHandler<never>,
	options: ChangeOptions<never>,
	state: State,
	how: Listening,
): Promise<CloseReason> {
	while (!state.closing) {
		const stream = ctx.collection.watch(
			how.pipeline,
			watchOptionsOf(ctx, state.token),
		);
		state.stream = stream;
		try {
			return await drain(ctx, stream, handler, options, state, how.markReady);
		} catch (error) {
			// The caller's own error first: closing does not make it go away.
			if (error instanceof Stopped) throw error;
			if (state.closing) return 'closed';
			// The driver's token is the one it would resume from itself.
			state.token = stream.resumeToken ?? state.token;
			if (!worthRetrying(error) || state.failures >= how.retries) {
				throw toDataError(error, { collection: ctx.name });
			}
			state.failures += 1;
			await pause(state.failures, how.signal);
		} finally {
			await stream.close().catch(() => undefined);
		}
	}
	return 'closed';
}

function retriesOf(options: ChangeOptions<never>): number {
	const retries = options.retries ?? 5;
	if (!Number.isInteger(retries) || retries < 0) {
		throw new TypeError(
			`onChange: retries must be a whole number of at least 0, not ${String(retries)}`,
		);
	}
	return retries;
}

/**
 * Listens to the collection's changes, typed by its schema, until `close()`.
 *
 * Changes are handed over one at a time, each after the previous handler has
 * finished. The driver resumes on its own after a dropped connection; when it
 * gives up, the stream is reopened from the last token it held, so nothing is
 * missed while the process is up. A restarted process starts from now, unless
 * it passes a token it kept as `startAfter`.
 */
export function subscribe(
	ctx: CollectionContext,
	handler: ChangeHandler<never>,
	options: ChangeOptions<never> = {},
): ChangeSubscription {
	// Checked before anything is opened, so a bad filter throws here.
	const pipeline = pipelineOf(ctx, options);
	const retries = retriesOf(options);
	// Not `Promise.withResolvers`: the driver runs on Node 20, which lacks it.
	let markReady: () => void = () => undefined;
	let failReady: (error: unknown) => void = () => undefined;
	const ready = new Promise<void>((resolve, reject) => {
		markReady = resolve;
		failReady = reject;
	});
	// Handled here so that nobody awaiting `ready` does not also raise an
	// unhandled rejection: `closed` is the one that reports.
	ready.catch(() => undefined);
	const aborter = new AbortController();

	const state: State = {
		closing: false,
		stream: undefined,
		token: options.startAfter,
		handled: undefined,
		failures: 0,
	};

	const how = { pipeline, retries, signal: aborter.signal, markReady };
	const closed = listen(ctx, handler, options, state, how).then(
		(reason) => {
			markReady();
			return reason;
		},
		async (error: unknown): Promise<CloseReason> => {
			const cause = error instanceof Stopped ? error.cause : error;
			failReady(cause);
			const told = error instanceof Stopped && error.told;
			if (told || !options.onError) throw cause;
			await options.onError(cause, undefined);
			return 'failed';
		},
	);

	const close = async () => {
		state.closing = true;
		aborter.abort();
		await state.stream?.close().catch(() => undefined);
		// From inside a handler, the subscription stops once it returns:
		// waiting for that here would wait for ourselves.
		if (delivering.getStore() === state) return;
		await closed.catch(() => undefined);
	};

	return {
		ready,
		closed,
		get resumeToken() {
			return state.handled as never;
		},
		close,
		[Symbol.asyncDispose]: close,
	};
}

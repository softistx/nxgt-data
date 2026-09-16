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
 * Server errors a new stream would only meet again: the stream's history is
 * gone (286), the server says so outright (280), or the user may not read
 * (13, 18). Everything else the driver did not recover from is worth another
 * try from the last token — measured, a plain server error on `getMore`
 * closes the driver's stream with its token intact.
 */
const FATAL = new Set([13, 18, 280, 286]);

function worthRetrying(error: unknown): boolean {
	const { name, code } = (error ?? {}) as { name?: unknown; code?: unknown };
	if (typeof name !== 'string' || !name.startsWith('Mongo')) return false;
	if (name === 'MongoAPIError') return false;
	return typeof code !== 'number' || !FATAL.has(code);
}

/** A handler's own failure, told apart from the stream's. */
class HandlerFailure {
	constructor(readonly cause: unknown) {}
}

/** Where one subscription is. Data only, like the collection's context. */
interface State {
	closing: boolean;
	stream: ChangeStream | undefined;
	/** Where to reopen from. */
	token: unknown;
	/** The token of the last change handled: what `resumeToken` shows. */
	handled: unknown;
	failures: number;
	/** Ends a wait between two attempts early, when `close()` is called. */
	wake: (() => void) | undefined;
	markReady: () => void;
}

function pause(state: State, attempt: number): Promise<void> {
	const ms = Math.min(100 * 2 ** (attempt - 1), 10_000);
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		state.wake = () => {
			clearTimeout(timer);
			resolve();
		};
	});
}

/** Hands one change to the handler, or its error to `onError`. */
async function deliver(
	handler: ChangeHandler<never>,
	change: Document,
	options: ChangeOptions<never>,
): Promise<void> {
	try {
		await handler(change as never);
	} catch (error) {
		if (!options.onError) throw new HandlerFailure(error);
		try {
			await options.onError(error, change as never);
		} catch (again) {
			throw new HandlerFailure(again);
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
): Promise<CloseReason> {
	while (!state.closing) {
		// `tryNext` answers `null` after a server-side wait with nothing new,
		// which is also what makes the first call open the stream.
		const event = await stream.tryNext();
		state.markReady();
		if (!event) continue;
		if (event.operationType === 'invalidate') return 'invalidated';
		state.failures = 0;
		const change = toChange(ctx, event as Document, options);
		if (change) await deliver(handler, change, options);
		state.handled = event._id;
		state.token = event._id;
	}
	return 'closed';
}

/** Opens streams until one ends for good, reopening from the last token. */
async function listen(
	ctx: CollectionContext,
	pipeline: Document[],
	handler: ChangeHandler<never>,
	options: ChangeOptions<never>,
	state: State,
): Promise<CloseReason> {
	const retries = options.retries ?? 5;
	while (!state.closing) {
		const stream = ctx.collection.watch(
			pipeline,
			watchOptionsOf(ctx, state.token),
		);
		state.stream = stream;
		try {
			return await drain(ctx, stream, handler, options, state);
		} catch (error) {
			if (state.closing) return 'closed';
			if (error instanceof HandlerFailure) throw error.cause;
			// The driver's token is the one it would resume from itself.
			state.token = stream.resumeToken ?? state.token;
			if (!worthRetrying(error) || state.failures >= retries) {
				throw toDataError(error, { collection: ctx.name });
			}
			state.failures += 1;
			await pause(state, state.failures);
		} finally {
			await stream.close().catch(() => undefined);
		}
	}
	return 'closed';
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
	// Built before anything is opened, so a filter it refuses throws here.
	const pipeline = pipelineOf(ctx, options);
	let markReady = () => {};
	let failReady: (error: unknown) => void = () => {};
	const ready = new Promise<void>((resolve, reject) => {
		markReady = resolve;
		failReady = reject;
	});
	// Handled here so that a subscription nobody awaited `ready` on does not
	// also raise an unhandled rejection: `closed` is the one that reports.
	ready.catch(() => undefined);

	const state: State = {
		closing: false,
		stream: undefined,
		token: options.startAfter,
		handled: undefined,
		failures: 0,
		wake: undefined,
		markReady,
	};

	const closed = listen(ctx, pipeline, handler, options, state).then(
		(reason) => {
			markReady();
			return reason;
		},
		async (error: unknown): Promise<CloseReason> => {
			failReady(error);
			if (!options.onError) throw error;
			await options.onError(error, undefined);
			return 'failed';
		},
	);

	const close = async () => {
		state.closing = true;
		state.wake?.();
		await state.stream?.close().catch(() => undefined);
		await closed.catch(() => undefined);
	};

	return {
		ready,
		closed,
		get resumeToken() {
			return state.handled;
		},
		close,
		[Symbol.asyncDispose]: close,
	};
}

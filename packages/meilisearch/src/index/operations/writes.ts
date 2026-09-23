import type {
	DocumentOptions,
	EnqueuedTaskPromise,
	Filter,
	Task,
	WaitOptions,
} from 'meilisearch';
import { assertSucceeded } from '../../errors/search-index-error';
import { type IndexContext, records } from '../context';
import type { BatchWriteOptions, WriteOptions } from '../types';

function waitOptions(wait: boolean | WaitOptions | undefined) {
	return wait === true ? {} : wait || undefined;
}

// Every write names the primary key: an index a write creates, before any
// `sync`, then gets the definition's instead of one Meilisearch guesses.
function documentOptions(
	ctx: IndexContext,
	options: WriteOptions = {},
): DocumentOptions {
	return {
		primaryKey: ctx.primaryKey,
		...(options.customMetadata === undefined
			? {}
			: { customMetadata: options.customMetadata }),
	};
}

function taskOptions(options: WriteOptions = {}) {
	return options.customMetadata === undefined
		? undefined
		: { customMetadata: options.customMetadata };
}

function settle(
	ctx: IndexContext,
	enqueued: EnqueuedTaskPromise,
	options?: WriteOptions,
) {
	const wait = waitOptions(options?.wait);
	if (wait === undefined) return enqueued;
	return enqueued
		.waitTask(wait)
		.then((task: Task) => assertSucceeded(task, ctx.uid));
}

// The return type is written out: inferred, it names the SDK's internal
// `SafeOmit`, and the declaration emit of the batch writes fails (TS2883).
function settleAll(
	ctx: IndexContext,
	enqueued: EnqueuedTaskPromise[],
	options?: WriteOptions,
): EnqueuedTaskPromise[] | Promise<Task[]> {
	const wait = waitOptions(options?.wait);
	if (wait === undefined) return enqueued;
	return Promise.all(
		enqueued.map((task) =>
			task.waitTask(wait).then((done) => assertSucceeded(done, ctx.uid)),
		),
	);
}

export function add(
	ctx: IndexContext,
	documents: readonly unknown[],
	options?: WriteOptions,
) {
	return settle(
		ctx,
		ctx.raw.addDocuments(records(documents), documentOptions(ctx, options)),
		options,
	);
}

export function addInBatches(
	ctx: IndexContext,
	documents: readonly unknown[],
	options?: BatchWriteOptions,
) {
	return settleAll(
		ctx,
		ctx.raw.addDocumentsInBatches(
			records(documents),
			options?.batchSize,
			documentOptions(ctx, options),
		),
		options,
	);
}

export function update(
	ctx: IndexContext,
	documents: readonly unknown[],
	options?: WriteOptions,
) {
	return settle(
		ctx,
		ctx.raw.updateDocuments(records(documents), documentOptions(ctx, options)),
		options,
	);
}

export function updateInBatches(
	ctx: IndexContext,
	documents: readonly unknown[],
	options?: BatchWriteOptions,
) {
	return settleAll(
		ctx,
		ctx.raw.updateDocumentsInBatches(
			records(documents),
			options?.batchSize,
			documentOptions(ctx, options),
		),
		options,
	);
}

export function remove(
	ctx: IndexContext,
	ids: unknown,
	options?: WriteOptions,
) {
	return settle(
		ctx,
		Array.isArray(ids)
			? ctx.raw.deleteDocuments(ids as string[], taskOptions(options))
			: ctx.raw.deleteDocument(ids as string | number, taskOptions(options)),
		options,
	);
}

export function deleteByFilter(
	ctx: IndexContext,
	filter: Filter,
	options?: WriteOptions,
) {
	return settle(
		ctx,
		ctx.raw.deleteDocuments({ filter }, taskOptions(options)),
		options,
	);
}

export function deleteAll(ctx: IndexContext, options?: WriteOptions) {
	return settle(ctx, ctx.raw.deleteAllDocuments(taskOptions(options)), options);
}

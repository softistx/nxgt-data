import type { Document } from 'mongodb';
import { OptimisticLockError } from '../errors/data-error';
import { type CollectionContext, notFound, run } from './context';
import { toDocument, toUpdate, withId } from './documents';
import {
	type Fields,
	live,
	mergeFilters,
	requireFilter,
	scoped,
} from './filters';
import { findOne } from './reads';

/**
 * `findOneAndUpdate` answers `null` for a document that is not there, one
 * that is soft-deleted, and one whose version moved. Only a second read
 * tells them apart.
 */
async function updatedOrThrow(
	ctx: CollectionContext,
	id: unknown,
	filter: Fields,
	update: Fields,
	expectedVersion: number | undefined,
): Promise<Fields> {
	const updated = await run(ctx, async () =>
		ctx.collection.findOneAndUpdate(filter, update, {
			...ctx.sessionOption,
			returnDocument: 'after',
		}),
	);
	if (updated) return withId(ctx, updated as Fields);

	if (expectedVersion !== undefined) {
		const current = await findOne(ctx, { _id: id });
		if (current) {
			throw new OptimisticLockError(
				`Document ${String(id)} of "${ctx.name}" is at version ${String(
					current.version,
				)}, not ${expectedVersion}: it changed since it was read`,
				{
					collection: ctx.name,
					id,
					expectedVersion,
					actualVersion:
						typeof current.version === 'number' ? current.version : undefined,
				},
			);
		}
	}
	throw notFound(ctx, id);
}

/** What a soft delete writes: the stamps, and the lock if there is one. */
function softDeleteUpdate(ctx: CollectionContext): Fields {
	const set: Fields = { deletedAt: new Date() };
	if (ctx.actor !== undefined && ctx.stamps.deletedBy) {
		set.deletedBy = ctx.actor;
	}
	const update: Fields = { $set: set };
	if (ctx.locks) update.$inc = { version: 1 };
	return update;
}

export async function create(
	ctx: CollectionContext,
	values: unknown,
): Promise<Fields> {
	const document = toDocument(ctx, values);
	return run(ctx, async () => {
		await ctx.collection.insertOne(document as Document, {
			...ctx.sessionOption,
		});
		return withId(ctx, document);
	});
}

export async function createMany(
	ctx: CollectionContext,
	values: readonly unknown[],
): Promise<Fields[]> {
	if (values.length === 0) return [];
	const documents = values.map((value) => toDocument(ctx, value));
	return run(ctx, async () => {
		await ctx.collection.insertMany(documents as Document[], {
			...ctx.sessionOption,
		});
		return documents.map((document) => withId(ctx, document));
	});
}

export async function update(
	ctx: CollectionContext,
	id: unknown,
	patch: unknown,
	opts: Fields = {},
): Promise<Fields> {
	const expectedVersion = opts.expectedVersion as number | undefined;
	if (expectedVersion !== undefined && !ctx.locks) {
		throw new TypeError(
			`update: expectedVersion needs a "version" field, and "${ctx.name}" has none`,
		);
	}
	const patched = toUpdate(ctx, patch);
	const filter = mergeFilters(
		{
			_id: id,
			...(expectedVersion === undefined ? {} : { version: expectedVersion }),
		},
		live(ctx),
	);
	return updatedOrThrow(ctx, id, filter, patched, expectedVersion);
}

export async function updateMany(
	ctx: CollectionContext,
	filter: unknown,
	patch: unknown,
): Promise<number> {
	requireFilter(ctx, 'updateMany', filter);
	const patched = toUpdate(ctx, patch);
	return run(ctx, async () => {
		const result = await ctx.collection.updateMany(
			scoped(ctx, filter),
			patched,
			{ ...ctx.sessionOption },
		);
		return result.modifiedCount;
	});
}

export async function hardDelete(
	ctx: CollectionContext,
	id: unknown,
): Promise<Fields> {
	const deleted = await run(ctx, async () =>
		ctx.collection.findOneAndDelete({ _id: id }, { ...ctx.sessionOption }),
	);
	if (!deleted) throw notFound(ctx, id);
	return withId(ctx, deleted as Fields);
}

export async function hardDeleteMany(
	ctx: CollectionContext,
	filter: unknown,
): Promise<number> {
	requireFilter(ctx, 'hardDeleteMany', filter);
	return run(ctx, async () => {
		const result = await ctx.collection.deleteMany(filter as Fields, {
			...ctx.sessionOption,
		});
		return result.deletedCount;
	});
}

export async function deleteOne(
	ctx: CollectionContext,
	id: unknown,
): Promise<Fields> {
	if (!ctx.softDeletes) return hardDelete(ctx, id);
	return updatedOrThrow(
		ctx,
		id,
		mergeFilters({ _id: id }, live(ctx)),
		softDeleteUpdate(ctx),
		undefined,
	);
}

export async function deleteMany(
	ctx: CollectionContext,
	filter: unknown,
): Promise<number> {
	requireFilter(ctx, 'deleteMany', filter);
	if (!ctx.softDeletes) return hardDeleteMany(ctx, filter);
	return run(ctx, async () => {
		const result = await ctx.collection.updateMany(
			scoped(ctx, filter),
			softDeleteUpdate(ctx),
			{ ...ctx.sessionOption },
		);
		return result.modifiedCount;
	});
}

export async function restore(
	ctx: CollectionContext,
	id: unknown,
): Promise<Fields> {
	if (!ctx.stamps.deletedAt) {
		throw new TypeError(`restore: "${ctx.name}" has no soft delete`);
	}
	const set: Fields = { deletedAt: null };
	if (ctx.stamps.deletedBy) set.deletedBy = null;
	if (ctx.touches) set.updatedAt = new Date();
	const update: Fields = { $set: set };
	if (ctx.locks) update.$inc = { version: 1 };
	return updatedOrThrow(ctx, id, { _id: id }, update, undefined);
}

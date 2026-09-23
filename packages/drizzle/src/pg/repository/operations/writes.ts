import { and, eq, sql } from 'drizzle-orm';
import { whereToSql } from '../conditions';
import {
	type AnyRow,
	builders,
	notFound,
	type RepositoryContext,
	run,
} from '../context';
import { byId, live, requireWhere, scoped } from '../filters';
import { created, expecting, lockError, touched } from '../stamp-writes';
import type { FindManyOptions } from '../types';
import { findById, findMany, getById } from './reads';

export async function create(
	ctx: RepositoryContext,
	values: AnyRow,
): Promise<AnyRow> {
	return run(ctx, async () => {
		const { d, t } = builders(ctx);
		const rows = await d.insert(t).values(created(ctx, values)).returning();
		return rows[0] as AnyRow;
	});
}

export async function createMany(
	ctx: RepositoryContext,
	values: readonly AnyRow[],
): Promise<AnyRow[]> {
	if (values.length === 0) return [];
	return run(ctx, async () => {
		const { d, t } = builders(ctx);
		return d
			.insert(t)
			.values(values.map((row) => created(ctx, row)))
			.returning();
	});
}

export async function update(
	ctx: RepositoryContext,
	id: unknown,
	given: AnyRow,
): Promise<AnyRow> {
	const { patch, expected } = expecting(ctx, 'update', given);
	const set = touched(ctx, patch);
	// Nothing to write, so nothing is written — and the row comes back as it
	// stands, rather than an `UPDATE` that only raises the stamps. An expected
	// version is still checked: the caller asked whether the row moved.
	if (Object.keys(set).length === 0) {
		const row = await getById(ctx, id);
		if (expected !== undefined && ctx.info.version) {
			if (row[ctx.info.version.key] !== expected) {
				throw lockError(ctx, id, expected, row);
			}
		}
		return row;
	}
	const version = ctx.info.version;
	const rows = await run(ctx, async () => {
		const { d, t } = builders(ctx);
		return d
			.update(t)
			.set(set)
			.where(
				and(
					byId(ctx, id),
					live(ctx),
					expected !== undefined && version
						? eq(version.column, expected)
						: undefined,
				),
			)
			.returning();
	});
	if (rows[0]) return rows[0] as AnyRow;
	// No row matched: missing, soft-deleted, or at another version. Only a
	// second read tells the last one apart, and only it is a lock failure.
	const current = expected === undefined ? undefined : await findById(ctx, id);
	if (current && expected !== undefined) {
		throw lockError(ctx, id, expected, current);
	}
	throw notFound(ctx, id);
}

export async function updateMany(
	ctx: RepositoryContext,
	where: unknown,
	patch: AnyRow,
): Promise<AnyRow[]> {
	requireWhere(ctx, 'updateMany', where);
	const set = touched(ctx, expecting(ctx, 'updateMany', patch).patch);
	if (Object.keys(set).length === 0) {
		return findMany(ctx, { where: where as FindManyOptions<any>['where'] });
	}
	return run(ctx, async () => {
		const { d, t } = builders(ctx);
		return d.update(t).set(set).where(scoped(ctx, where)).returning();
	});
}

export async function hardDelete(
	ctx: RepositoryContext,
	id: unknown,
): Promise<AnyRow> {
	return run(ctx, async () => {
		const { d, t } = builders(ctx);
		const rows = await d.delete(t).where(byId(ctx, id)).returning();
		if (!rows[0]) throw notFound(ctx, id);
		return rows[0] as AnyRow;
	});
}

export async function hardDeleteMany(
	ctx: RepositoryContext,
	where: unknown,
): Promise<AnyRow[]> {
	requireWhere(ctx, 'hardDeleteMany', where);
	return run(ctx, async () => {
		const { d, t } = builders(ctx);
		return d.delete(t).where(whereToSql(ctx.info, where)).returning();
	});
}

/** What a soft delete writes: the time, and who, when someone is acting. */
function deletion(ctx: RepositoryContext, deletedAt: string): AnyRow {
	const set: AnyRow = { [deletedAt]: sql`now()` };
	const deletedBy = ctx.info.deletedBy;
	if (deletedBy && ctx.actor !== undefined) set[deletedBy.key] = ctx.actor;
	return set;
}

/** What a restore writes: no time, and nobody, of deletion. */
function restoration(ctx: RepositoryContext, deletedAt: string): AnyRow {
	const set: AnyRow = { [deletedAt]: null };
	if (ctx.info.deletedBy) set[ctx.info.deletedBy.key] = null;
	return set;
}

/** Soft delete when the table has the field for it, a real delete otherwise. */
export async function deleteOne(
	ctx: RepositoryContext,
	id: unknown,
): Promise<AnyRow> {
	const deletedAt = ctx.info.deletedAt;
	if (!deletedAt) return hardDelete(ctx, id);
	return run(ctx, async () => {
		const { d, t } = builders(ctx);
		const rows = await d
			.update(t)
			.set(touched(ctx, deletion(ctx, deletedAt.key)))
			.where(and(byId(ctx, id), live(ctx)))
			.returning();
		if (!rows[0]) throw notFound(ctx, id);
		return rows[0] as AnyRow;
	});
}

export async function deleteMany(
	ctx: RepositoryContext,
	where: unknown,
): Promise<AnyRow[]> {
	requireWhere(ctx, 'deleteMany', where);
	const deletedAt = ctx.info.deletedAt;
	if (!deletedAt) return hardDeleteMany(ctx, where);
	return run(ctx, async () => {
		const { d, t } = builders(ctx);
		return d
			.update(t)
			.set(touched(ctx, deletion(ctx, deletedAt.key)))
			.where(scoped(ctx, where))
			.returning();
	});
}

export async function restore(
	ctx: RepositoryContext,
	id: unknown,
): Promise<AnyRow> {
	const deletedAt = ctx.info.deletedAt;
	if (!deletedAt) {
		throw new TypeError(`restore: "${ctx.info.name}" has no soft delete`);
	}
	return run(ctx, async () => {
		const { d, t } = builders(ctx);
		const rows = await d
			.update(t)
			.set(touched(ctx, restoration(ctx, deletedAt.key)))
			.where(byId(ctx, id))
			.returning();
		if (!rows[0]) throw notFound(ctx, id);
		return rows[0] as AnyRow;
	});
}

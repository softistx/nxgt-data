import { and, sql } from 'drizzle-orm';
import { whereToSql } from '../conditions';
import {
	type AnyRow,
	builders,
	notFound,
	type RepositoryContext,
	run,
} from '../context';
import { byId, live, requireWhere, scoped } from '../filters';
import { touched } from '../stamp-writes';
import type { FindManyOptions } from '../types';
import { findMany, getById } from './reads';

export async function create(
	ctx: RepositoryContext,
	values: AnyRow,
): Promise<AnyRow> {
	return run(ctx, async () => {
		const { d, t } = builders(ctx);
		const rows = await d.insert(t).values(values).returning();
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
			.values([...values])
			.returning();
	});
}

export async function update(
	ctx: RepositoryContext,
	id: unknown,
	patch: AnyRow,
): Promise<AnyRow> {
	const set = touched(ctx, patch);
	// Nothing to write, so nothing is written — and the row comes back as it
	// stands, rather than an `UPDATE` that only raises `updatedAt`.
	if (Object.keys(set).length === 0) return getById(ctx, id);
	return run(ctx, async () => {
		const { d, t } = builders(ctx);
		const rows = await d
			.update(t)
			.set(set)
			.where(and(byId(ctx, id), live(ctx)))
			.returning();
		if (!rows[0]) throw notFound(ctx, id);
		return rows[0] as AnyRow;
	});
}

export async function updateMany(
	ctx: RepositoryContext,
	where: unknown,
	patch: AnyRow,
): Promise<AnyRow[]> {
	requireWhere(ctx, 'updateMany', where);
	const set = touched(ctx, patch);
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
			.set(touched(ctx, { [deletedAt.key]: sql`now()` }))
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
			.set(touched(ctx, { [deletedAt.key]: sql`now()` }))
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
			.set(touched(ctx, { [deletedAt.key]: null }))
			.where(byId(ctx, id))
			.returning();
		if (!rows[0]) throw notFound(ctx, id);
		return rows[0] as AnyRow;
	});
}

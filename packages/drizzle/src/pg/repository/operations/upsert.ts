import { is, SQL, sql } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { ArgumentError } from '../../../errors/argument-error';
import { ConflictError, DataError } from '../../../errors/data-error';
import { isPlainObject, shapeOf } from '../conditions';
import { type AnyRow, builders, type RepositoryContext, run } from '../context';
import { live } from '../filters';
import { created, expecting, touched } from '../stamp-writes';

/** A column the `where` names, and so the conflict target. */
interface Seed {
	key: string;
	column: PgColumn;
}

/**
 * `INSERT … ON CONFLICT (<the where's columns>) DO UPDATE … WHERE <live>
 * RETURNING *`: one statement, so there is no read to go stale between the
 * look-up and the write, and two callers racing on one key leave one row.
 *
 * The unique constraint on those columns is the guarantee, and PostgreSQL
 * will not run the statement without one. A row that is there but
 * soft-deleted is not written over: the `WHERE` leaves it out, nothing comes
 * back, and the call says so with a `ConflictError`.
 */
export async function upsert(
	ctx: RepositoryContext,
	where: unknown,
	given: unknown,
): Promise<AnyRow> {
	const seeds = seedsOf(ctx, where);
	const values = valuesOf(ctx, seeds, given);
	const row = created(ctx, { ...values, ...(where as AnyRow) });
	const set = conflictSet(ctx, seeds, values);
	const target = seeds.map((seed) => seed.column);
	const rows = await run(ctx, async () => {
		const { d, t } = builders(ctx);
		return d
			.insert(t)
			.values(row)
			.onConflictDoUpdate({ target, set, setWhere: live(ctx) })
			.returning();
	}).catch((error: unknown) => {
		throw noTarget(ctx, seeds, error);
	});
	if (rows[0]) return rows[0] as AnyRow;
	throw new ConflictError(
		`upsert on "${ctx.info.name}": the row with this (${names(seeds)}) is soft-deleted. ` +
			'Restore it, or hard-delete it, before writing over its key',
		{ table: ctx.info.name, columns: seeds.map((seed) => seed.column.name) },
	);
}

/**
 * The columns the `where` names, refused unless each holds a plain value.
 *
 * The `where` is inserted as well as matched, so it is held to what a write
 * is held to: a Drizzle condition seeds nothing, a `null` never conflicts —
 * every call would insert — and a key that is no column cannot be written.
 */
function seedsOf(ctx: RepositoryContext, where: unknown): Seed[] {
	const on = `upsert on "${ctx.info.name}"`;
	if (!isPlainObject(where)) {
		throw new ArgumentError(
			'where',
			`${on}: the where must be an object of column values, not ${shapeOf(where)}`,
		);
	}
	const seeds: Seed[] = [];
	for (const [key, value] of Object.entries(where)) {
		const column = ctx.info.columns[key];
		if (!column) {
			throw new ArgumentError(
				'where',
				`${on}: the where names "${key}", which is no column of the table`,
				{ key },
			);
		}
		if (value === undefined || value === null || is(value, SQL)) {
			throw new ArgumentError(
				'where',
				`${on}: "${key}" in the where is ${shapeOf(value)}. It is inserted as well as matched, ` +
					'so it must be a value, and NULL never conflicts',
				{ key },
			);
		}
		if (ctx.info.version?.key === key) {
			throw new ArgumentError(
				'where',
				`${on}: "${key}" is the optimistic lock, which the repository keeps. Leave it out`,
				{ key },
			);
		}
		seeds.push({ key, column });
	}
	if (seeds.length === 0) {
		throw new ArgumentError(
			'where',
			`${on}: the where is empty. Name the columns a unique constraint covers`,
		);
	}
	return seeds;
}

/** The values, refused where they say what the `where` already says. */
function valuesOf(
	ctx: RepositoryContext,
	seeds: readonly Seed[],
	given: unknown,
): AnyRow {
	if (!isPlainObject(given)) {
		throw new ArgumentError(
			'values',
			`upsert on "${ctx.info.name}": the values must be an object, not ${shapeOf(given)}`,
		);
	}
	for (const seed of seeds) {
		if (given[seed.key] !== undefined) {
			throw new ArgumentError(
				'values',
				`upsert on "${ctx.info.name}": "${seed.key}" is in both the where and the values. Name it in the where alone`,
				{ key: seed.key },
			);
		}
	}
	return expecting(ctx, 'upsert', given).patch;
}

/** The stamps an update never moves: they say how the row was created. */
const CREATION = ['createdAt', 'createdBy'];

/**
 * Whether the update half leaves this key alone: a creation stamp, or the
 * primary key. A `values` that names the id chooses it for an insert; on a
 * row that is already there it would move the row to another id, which
 * `@nxgt/mongo`'s upsert does not do to `_id` either.
 */
function kept(ctx: RepositoryContext, key: string): boolean {
	const pk = ctx.info.primaryKey;
	return CREATION.includes(key) || ('key' in pk && pk.key === key);
}

/**
 * What the update half sets: each value the call gives, read from `excluded`
 * so it is sent once, plus the stamps `update` adds — and never the primary
 * key or a creation stamp.
 *
 * With nothing to write, it still has to set something — `DO UPDATE` with an
 * empty `SET` is not SQL, and `DO NOTHING` returns no row. It sets the target
 * to itself, and every `$onUpdate` column to its own value, which Drizzle
 * would otherwise stamp: a call that writes nothing records no write, as an
 * empty `update` does.
 */
function conflictSet(
	ctx: RepositoryContext,
	seeds: readonly Seed[],
	values: AnyRow,
): AnyRow {
	const written: AnyRow = {};
	for (const [key, value] of Object.entries(values)) {
		const column = ctx.info.columns[key];
		if (value === undefined || !column || kept(ctx, key)) continue;
		written[key] = excluded(column);
	}
	if (Object.keys(written).length > 0) return touched(ctx, written);
	const [first] = seeds as [Seed];
	const same: AnyRow = { [first.key]: excluded(first.column) };
	for (const [key, column] of Object.entries(ctx.info.columns)) {
		if (column.onUpdateFn) same[key] = sql`${column}`;
	}
	return same;
}

function excluded(column: PgColumn): SQL {
	return sql`excluded.${sql.identifier(column.name)}`;
}

/**
 * PostgreSQL's `42P10`, said in this call's terms: the `where` named columns
 * no unique constraint covers exactly, so there is nothing to conflict on.
 * Any other error goes on as it came.
 */
function noTarget(
	ctx: RepositoryContext,
	seeds: readonly Seed[],
	error: unknown,
): unknown {
	if (!(error instanceof DataError) || error.sqlState !== '42P10') return error;
	return new DataError(
		`upsert on "${ctx.info.name}": no unique constraint covers exactly (${names(seeds)}), the where's columns. ` +
			'Add one, or name the columns one covers',
		{
			cause: error,
			sqlState: error.sqlState,
			table: ctx.info.name,
			columns: seeds.map((seed) => seed.column.name),
		},
	);
}

function names(seeds: readonly Seed[]): string {
	return seeds.map((seed) => seed.column.name).join(', ');
}

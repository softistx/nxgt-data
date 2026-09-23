import { sql } from 'drizzle-orm';
import { ArgumentError } from '../../errors/argument-error';
import { OptimisticLockError } from '../../errors/data-error';
import { shapeOf } from './conditions';
import type { AnyRow, RepositoryContext } from './context';

/**
 * The values an insert writes, with `createdBy` and `updatedBy` filled from
 * the actor. A value the caller gave — an import, a backfill — is kept, the
 * way a `createdAt` given to `create` is.
 */
export function created(ctx: RepositoryContext, values: AnyRow): AnyRow {
	if (ctx.actor === undefined) return values;
	const row: AnyRow = { ...values };
	for (const stamp of [ctx.info.createdBy, ctx.info.updatedBy]) {
		if (stamp && row[stamp.key] === undefined) row[stamp.key] = ctx.actor;
	}
	return row;
}

/**
 * The patch a write sets, with the stamps this repository keeps added to it:
 * `updatedAt = now()`, `updatedBy` from the actor, and `version + 1` where it
 * locks.
 *
 * Three things keep them off. An `undefined` value is dropped rather than
 * written, so a patch that is entirely `undefined` sets nothing and the caller
 * gets the row back untouched — raising `updatedAt` or the version there would
 * record a write that did not happen. A patch that sets a stamp itself is left
 * alone. And a column Drizzle stamps through `$onUpdate` is left to Drizzle,
 * which would otherwise write it twice.
 */
export function touched(ctx: RepositoryContext, patch: AnyRow): AnyRow {
	const set: AnyRow = {};
	for (const [key, value] of Object.entries(patch)) {
		if (value !== undefined) set[key] = value;
	}
	if (Object.keys(set).length === 0) return set;
	const { updatedAt, updatedBy, version } = ctx.info;
	if (updatedAt && !(updatedAt.key in set) && !updatedAt.column.onUpdateFn) {
		set[updatedAt.key] = sql`now()`;
	}
	if (updatedBy && ctx.actor !== undefined && !(updatedBy.key in set)) {
		set[updatedBy.key] = ctx.actor;
	}
	if (version) set[version.key] = sql`${version.column} + 1`;
	return set;
}

/** A patch, and the version it is conditional on. */
export interface Expecting {
	patch: AnyRow;
	expected: number | undefined;
}

/**
 * Takes the expected version out of a patch: on a repository that locks, the
 * `version` a patch gives is not written but checked — the row it reads
 * back must still be at it, and the update then raises it by one.
 *
 * Only `update` takes one. `updateMany` and `upsert` refuse it — one version
 * cannot stand for many rows, and a row that may not exist has no version to
 * be at — and so does a version that is not a whole number, since it is a
 * value off a request body more often than not.
 */
export function expecting(
	ctx: RepositoryContext,
	method: 'update' | 'updateMany' | 'upsert',
	patch: AnyRow,
): Expecting {
	const version = ctx.info.version;
	if (!version || patch[version.key] === undefined) {
		return { patch, expected: undefined };
	}
	const { [version.key]: expected, ...rest } = patch;
	const argument = method === 'upsert' ? 'values' : 'patch';
	if (method !== 'update') {
		throw new ArgumentError(
			argument,
			`${method} on "${ctx.info.name}": "${version.key}" is the optimistic lock, which only update checks. ` +
				'Leave it out; every write raises it',
			{ key: version.key },
		);
	}
	if (
		typeof expected !== 'number' ||
		!Number.isInteger(expected) ||
		expected < 0
	) {
		throw new ArgumentError(
			argument,
			`update on "${ctx.info.name}": the expected "${version.key}" must be a whole number, not ${shapeOf(expected)}`,
			{ key: version.key },
		);
	}
	return { patch: rest, expected };
}

/**
 * The row is there and its version moved. The values are on the error, not in
 * the message: the id is a caller's, and a log line is not the place for it.
 */
export function lockError(
	ctx: RepositoryContext,
	id: unknown,
	expectedVersion: number,
	row: AnyRow,
): OptimisticLockError {
	const actual = ctx.info.version && row[ctx.info.version.key];
	return new OptimisticLockError(
		`update on "${ctx.info.name}": the row is no longer at the version the patch expected: it changed since it was read`,
		{
			table: ctx.info.name,
			id,
			expectedVersion,
			actualVersion: typeof actual === 'number' ? actual : undefined,
		},
	);
}

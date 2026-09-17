import { MigrationError } from './errors';
import type {
	Migration,
	MigrationRecord,
	MigrationStatus,
	MigrationStep,
} from './types';

/**
 * Where the list and the records agree, and where they do not. Pure: what is
 * recorded is read before, and nothing here touches the database.
 */

/** Refuses a list that names one id twice. */
export function checkList(migrations: readonly Migration[]): void {
	const seen = new Set<string>();
	for (const migration of migrations) {
		if (seen.has(migration.id)) {
			throw new MigrationError(`Migration "${migration.id}" is listed twice`, {
				migration: migration.id,
			});
		}
		seen.add(migration.id);
	}
}

/** Every listed migration and every recorded one, in the list's order. */
export function statusOf(
	migrations: readonly Migration[],
	records: readonly MigrationRecord[],
): MigrationStatus[] {
	const recorded = new Map(records.map((r) => [r._id, r]));
	const listed = new Set(migrations.map((m) => m.id));
	const status: MigrationStatus[] = migrations.map(({ id }) => ({
		id,
		state: recorded.has(id) ? 'applied' : 'pending',
		appliedAt: recorded.get(id)?.appliedAt,
	}));
	for (const record of records) {
		if (!listed.has(record._id)) {
			status.push({
				id: record._id,
				state: 'missing',
				appliedAt: record.appliedAt,
			});
		}
	}
	return status;
}

/**
 * What the list says has been applied must be a prefix of it: a recorded id
 * the list lost, or a pending one listed before an applied one, means the
 * list was edited under a database that already followed it. Running on
 * from there would apply migrations out of the order they were written for.
 */
export function checkApplied(
	migrations: readonly Migration[],
	records: readonly MigrationRecord[],
): number {
	const status = statusOf(migrations, records);
	const missing = status.find((s) => s.state === 'missing');
	if (missing) {
		throw new MigrationError(
			`Migration "${missing.id}" is recorded as applied and is no longer ` +
				'in the list. Put it back, or remove its record by hand.',
			{ migration: missing.id },
		);
	}
	const applied = status.filter((s) => s.state === 'applied').length;
	const gap = status.slice(0, applied).find((s) => s.state === 'pending');
	if (gap) {
		throw new MigrationError(
			`Migration "${gap.id}" is pending and listed before one that is ` +
				'already applied. A new migration goes at the end of the list.',
			{ migration: gap.id },
		);
	}
	return applied;
}

/** The index of `id` in the list, or a `MigrationError`. */
export function indexOf(
	migrations: readonly Migration[],
	id: string,
	option: string,
): number {
	const index = migrations.findIndex((m) => m.id === id);
	if (index === -1) {
		throw new MigrationError(`${option}: "${id}" is not in the list`, {
			migration: id,
		});
	}
	return index;
}

/** The migrations `migrate` runs: the pending ones, up to `to`. */
export function toApply(
	migrations: readonly Migration[],
	records: readonly MigrationRecord[],
	to: string | undefined,
): Migration[] {
	const applied = checkApplied(migrations, records);
	const end =
		to === undefined
			? migrations.length
			: indexOf(migrations, to, 'migrate') + 1;
	return migrations.slice(applied, Math.max(applied, end));
}

/** A migration to undo, with the `down` it was checked to have. */
export interface Reversal {
	migration: Migration;
	down: MigrationStep;
}

/**
 * The migrations `rollback` undoes, the last applied first: the one before
 * `to` down to it, or the last one alone. Refused as a whole when one of
 * them has no `down`, before anything is undone.
 */
export function toRevert(
	migrations: readonly Migration[],
	records: readonly MigrationRecord[],
	to: string | undefined,
): Reversal[] {
	const applied = checkApplied(migrations, records);
	const start =
		to === undefined
			? Math.max(0, applied - 1)
			: indexOf(migrations, to, 'rollback') + 1;
	const reverted = migrations.slice(start, Math.max(start, applied)).reverse();
	return reverted.map((migration) => {
		if (!migration.down) {
			throw new MigrationError(
				`Migration "${migration.id}" has no down, so it cannot be rolled back`,
				{ migration: migration.id },
			);
		}
		return { migration, down: migration.down };
	});
}

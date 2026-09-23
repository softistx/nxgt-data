import { getColumns, getTableName } from 'drizzle-orm';
import {
	getTableConfig,
	type PgColumn,
	type PgTable,
} from 'drizzle-orm/pg-core';

/** A stamp column, by its key on the table object. */
export interface StampColumn {
	key: string;
	column: PgColumn;
}

/** What the repository needs to know of a table, read once. */
export interface TableInfo {
	name: string;
	/** By key on the table object, which is also the key on a row. */
	columns: Record<string, PgColumn>;
	primaryKey: StampColumn | { error: string };
	/**
	 * The keys no update moves: every column of the declared primary key,
	 * composite or not, and the column the methods by id address rows by.
	 */
	keys: string[];
	deletedAt: StampColumn | undefined;
	updatedAt: StampColumn | undefined;
	/** The optimistic lock's column, when the repository locks. */
	version: StampColumn | undefined;
	createdBy: StampColumn | undefined;
	updatedBy: StampColumn | undefined;
	deletedBy: StampColumn | undefined;
}

export interface TableInfoOptions {
	primaryKey?: string | undefined;
	softDelete?: boolean | undefined;
	touchUpdatedAt?: boolean | undefined;
	optimisticLock?: boolean | undefined;
}

export function tableInfo(
	table: PgTable,
	options: TableInfoOptions = {},
): TableInfo {
	const name = getTableName(table);
	const columns = getColumns(table) as Record<string, PgColumn>;
	const at = (key: string): StampColumn | undefined => {
		const column = columns[key];
		return column ? { key, column } : undefined;
	};

	// Before the stamps, as it always was: a missing key is the first thing
	// a caller hears about.
	// Read once: both the key the methods by id use and the keys no update
	// moves come from it.
	const composite = getTableConfig(table).primaryKeys[0]?.columns ?? [];
	const primaryKey = primaryKeyOf(name, composite, columns, options.primaryKey);
	if (options.softDelete === true && !columns.deletedAt) {
		throw new TypeError(
			`createRepository: softDelete needs a "deletedAt" column, and "${name}" has none`,
		);
	}
	return {
		name,
		columns,
		primaryKey,
		keys: keysOf(composite, columns, primaryKey),
		deletedAt: options.softDelete !== false ? at('deletedAt') : undefined,
		updatedAt: options.touchUpdatedAt !== false ? at('updatedAt') : undefined,
		version: versionOf(name, at('version'), options.optimisticLock),
		createdBy: at('createdBy'),
		updatedBy: at('updatedBy'),
		deletedBy: at('deletedBy'),
	};
}

/** The integer types a version can be read back from as a `number`. */
const COUNTERS = new Set(['number int16', 'number int32', 'number int53']);

/**
 * The lock's column: on by default where the table has an integer `version`
 * that is `NOT NULL` — `null + 1` is `null`, and a lock on it checks nothing —
 * off with `optimisticLock: false`, which leaves `version` an ordinary column.
 *
 * A `version` that is not an integer is left alone by default — a `text`
 * `version` is somebody's data, not a counter — and refused when the lock is
 * asked for by name.
 */
function versionOf(
	name: string,
	column: StampColumn | undefined,
	optimisticLock: boolean | undefined,
): StampColumn | undefined {
	if (optimisticLock === false) return undefined;
	const counts = column
		? column.column.notNull && COUNTERS.has(column.column.dataType)
		: false;
	if (optimisticLock === true && !counts) {
		throw new TypeError(
			column
				? `createRepository: optimisticLock needs an integer NOT NULL "version" column, and "${name}"'s is not one`
				: `createRepository: optimisticLock needs a "version" column, and "${name}" has none`,
		);
	}
	return counts ? column : undefined;
}

/**
 * The keys of the declared primary key's columns — `.primaryKey()` on one, or
 * `primaryKey({ columns })` on several — and of the column rows are addressed
 * by, when it is another one: `primaryKey` names it, or it is the `id` a table
 * with no declared key falls back on.
 */
function keysOf(
	composite: readonly PgColumn[],
	columns: Record<string, PgColumn>,
	addressed: TableInfo['primaryKey'],
): string[] {
	// By name, not identity: measured on drizzle-orm 1.0.0-rc.4, the columns
	// `getTableConfig` gives for a `primaryKey({ columns })` are not the table's
	// own column objects, and `includes(column)` finds none of them.
	const names = composite.map((column) => column.name);
	const keys = Object.entries(columns)
		.filter(([, column]) => column.primary || names.includes(column.name))
		.map(([key]) => key);
	if ('key' in addressed && !keys.includes(addressed.key)) {
		keys.push(addressed.key);
	}
	return keys;
}

function primaryKeyOf(
	name: string,
	composite: readonly PgColumn[],
	columns: Record<string, PgColumn>,
	named: string | undefined,
): TableInfo['primaryKey'] {
	if (named !== undefined) {
		const column = columns[named];
		if (!column) {
			throw new TypeError(
				`createRepository: "${name}" has no column under the key "${named}"`,
			);
		}
		return { key: named, column };
	}
	const declared = Object.entries(columns).filter(([, c]) => c.primary);
	if (composite.length > 0) {
		const names = composite.map((c) => c.name).join(', ');
		return {
			error:
				`"${name}" has a composite primary key (${names}): the methods by id ` +
				'need one column. Pass `primaryKey` to createRepository to name a ' +
				'unique column, or use the methods that take a `where`.',
		};
	}
	if (declared.length === 1) {
		const [key, column] = declared[0] as [string, PgColumn];
		// The types default to `id`, the one key they can know of; a primary
		// key under another key would type the id as the wrong column.
		return key === 'id'
			? { key, column }
			: {
					error:
						`"${name}"'s primary key is under the key "${key}", not "id". Pass ` +
						`\`primaryKey: '${key}'\` to createRepository, which types the id too.`,
				};
	}
	if (columns.id) return { key: 'id', column: columns.id };
	return {
		error:
			`"${name}" has no primary key: the methods by id need one. Pass ` +
			'`primaryKey` to createRepository to name a unique column.',
	};
}

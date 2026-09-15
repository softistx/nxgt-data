import { getColumns, getTableName } from 'drizzle-orm';
import {
	getTableConfig,
	type PgColumn,
	type PgTable,
} from 'drizzle-orm/pg-core';

/** What the repository needs to know of a table, read once. */
export interface TableInfo {
	name: string;
	/** By key on the table object, which is also the key on a row. */
	columns: Record<string, PgColumn>;
	primaryKey: { key: string; column: PgColumn } | { error: string };
	deletedAt: { key: string; column: PgColumn } | undefined;
	updatedAt: { key: string; column: PgColumn } | undefined;
}

export interface TableInfoOptions {
	primaryKey?: string | undefined;
	softDelete?: boolean | undefined;
	touchUpdatedAt?: boolean | undefined;
}

export function tableInfo(
	table: PgTable,
	options: TableInfoOptions = {},
): TableInfo {
	const name = getTableName(table);
	const columns = getColumns(table) as Record<string, PgColumn>;

	let primaryKey: TableInfo['primaryKey'];
	if (options.primaryKey !== undefined) {
		const column = columns[options.primaryKey];
		if (!column) {
			throw new TypeError(
				`createRepository: "${name}" has no column under the key "${options.primaryKey}"`,
			);
		}
		primaryKey = { key: options.primaryKey, column };
	} else {
		const composite = getTableConfig(table).primaryKeys[0];
		const declared = Object.entries(columns).filter(([, c]) => c.primary);
		if (composite) {
			const names = composite.columns.map((c) => c.name).join(', ');
			primaryKey = {
				error:
					`"${name}" has a composite primary key (${names}): the methods by id ` +
					'need one column. Pass `primaryKey` to createRepository to name a ' +
					'unique column, or use the methods that take a `where`.',
			};
		} else if (declared.length === 1) {
			const [key, column] = declared[0] as [string, PgColumn];
			// The types default to `id`, the one key they can know of; a primary
			// key under another key would type the id as the wrong column.
			primaryKey =
				key === 'id'
					? { key, column }
					: {
							error:
								`"${name}"'s primary key is under the key "${key}", not "id". Pass ` +
								`\`primaryKey: '${key}'\` to createRepository, which types the id too.`,
						};
		} else if (columns.id) {
			primaryKey = { key: 'id', column: columns.id };
		} else {
			primaryKey = {
				error:
					`"${name}" has no primary key: the methods by id need one. Pass ` +
					'`primaryKey` to createRepository to name a unique column.',
			};
		}
	}

	const deletedColumn = columns.deletedAt;
	if (options.softDelete === true && !deletedColumn) {
		throw new TypeError(
			`createRepository: softDelete needs a "deletedAt" column, and "${name}" has none`,
		);
	}
	const deletedAt =
		options.softDelete !== false && deletedColumn
			? { key: 'deletedAt', column: deletedColumn }
			: undefined;

	const updatedColumn = columns.updatedAt;
	const updatedAt =
		options.touchUpdatedAt !== false && updatedColumn
			? { key: 'updatedAt', column: updatedColumn }
			: undefined;

	return { name, columns, primaryKey, deletedAt, updatedAt };
}

import type { BackupDefinition } from '../definition/define-backup';
import type { BackupSource, RestoreTarget } from '../source/types';
import { type BindBackupOptions, createContext } from './context';
import { type Created, createBackup } from './create';
import { type Listing, type ListOptions, listBackups } from './list';
import { type Restored, type RestoreOptions, restoreBackup } from './restore';
import { type Verified, type VerifyOptions, verifyBackup } from './verify';

/** A backup bound to its repositories and its recipients. */
export interface BoundBackup<Name extends string = string> {
	readonly definition: BackupDefinition<Name>;
	/** Repository names, in the order given. */
	readonly repositories: readonly string[];
	/**
	 * Reads every entry of `source` and stores a full backup in every
	 * repository. Resolves once each one holds it; rejects with `PARTIAL`
	 * or `NOT_STORED` otherwise, listing each repository's outcome.
	 */
	create(source: BackupSource): Promise<Created>;
	/** The backups one repository holds. Needs no key. */
	list(options?: ListOptions): Promise<Listing>;
	/** Reads one backup back and checks it. Needs a key only to check the entries. */
	verify(id: string, options?: VerifyOptions): Promise<Verified>;
	/** Writes one backup's entries, or some of them, to `target`. */
	restore(
		id: string,
		target: RestoreTarget,
		options: RestoreOptions,
	): Promise<Restored>;
}

/**
 * Binds a definition to where it is kept and who can read it. Nothing is
 * read or written until a method is called; a repository list or a
 * recipient that could never work is a bare `TypeError` here.
 */
export function bindBackup<Name extends string>(
	definition: BackupDefinition<Name>,
	options: BindBackupOptions,
): BoundBackup<Name> {
	const ctx = createContext(definition, options);
	return {
		definition,
		repositories: ctx.repositories.map((repository) => repository.name),
		create: (source) => createBackup(ctx, source),
		list: (listOptions) => listBackups(ctx, listOptions),
		verify: (id, verifyOptions) => verifyBackup(ctx, id, verifyOptions),
		restore: (id, target, restoreOptions) =>
			restoreBackup(ctx, id, target, restoreOptions),
	};
}

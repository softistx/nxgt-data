/** A backup described once: what it is called. Nothing is read or written. */
export interface BackupDefinition<Name extends string = string> {
	readonly name: Name;
}

export interface BackupDefinitionInput<Name extends string> {
	/**
	 * The backup's name, the first segment of every key it writes: 1 to 100
	 * characters, lowercase ASCII letters, digits, `.`, `_` and `-`, starting
	 * with a letter or a digit, and never holding `.partial-` (the marker
	 * `localRepository` gives a file being written). Several definitions can
	 * share a repository.
	 */
	name: Name;
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,99}$/;

/** Whether `name` is a backup name: it becomes a path segment and a key prefix. */
export function isBackupName(name: unknown): name is string {
	return (
		typeof name === 'string' && NAME.test(name) && !name.includes('.partial-')
	);
}

/**
 * Describes a backup. A name that could never be a path segment is refused
 * here, with a bare `TypeError` that gives the rule and not the name.
 */
export function defineBackup<const Name extends string>(
	input: BackupDefinitionInput<Name>,
): BackupDefinition<Name> {
	if (!isBackupName(input.name)) {
		throw new TypeError(
			'defineBackup: the name must be 1 to 100 characters, lowercase ' +
				'letters, digits, ".", "_" and "-", starting with a letter or a digit, ' +
				'without ".partial-"',
		);
	}
	return Object.freeze({ name: input.name });
}

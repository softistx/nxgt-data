/** One thing a source backs up: a file, a collection, a table. */
export interface SourceEntry {
	/**
	 * Its name, unique within the backup: a relative path, a collection's
	 * name. Not empty, at most 4096 characters, no NUL. It is encrypted with
	 * the data and never written in the clear.
	 */
	name: string;
	/** Its bytes, read when the backup gets to it, and only once. */
	open(): ReadableStream<Uint8Array> | Promise<ReadableStream<Uint8Array>>;
	/**
	 * What the source can say of it without reading it — a file's size,
	 * modification and change times and inode — at most 1024 bytes.
	 * An incremental or differential backup does not open an entry whose
	 * fingerprint is the one recorded in the backup it builds on: it points
	 * to that backup's copy. It must change whenever the bytes do; without
	 * one, every entry is read, and stored only if its bytes changed.
	 */
	fingerprint?: string | undefined;
}

/** What the backup an incremental or differential one builds on recorded. */
export interface Since {
	/** That backup's id. */
	id: string;
	/** Its `position`, if the source gave one. */
	position: string | undefined;
	/** Its entries, by name. */
	entries: ReadonlyMap<
		string,
		{ size: number; sha256: string; fingerprint: string | undefined }
	>;
}

/** What a backup reads from. */
export interface BackupSource {
	/** What it is, recorded in the backup: `directory`, `mongo`. */
	readonly kind: string;
	/**
	 * Its entries, each opened in turn: never two at once. Given `since`
	 * when the backup builds on another: an entry it no longer yields is
	 * not in the new backup, and one it yields with the recorded
	 * fingerprint is not opened.
	 */
	entries(since?: Since): AsyncIterable<SourceEntry>;
	/**
	 * Where the source is, once every entry was read — a change stream's
	 * resume token, a log's offset — recorded in the backup, encrypted, and
	 * given back in `since.position` to the next backup that builds on it.
	 * At most 64 KiB.
	 */
	position?(): string | undefined | Promise<string | undefined>;
}

/** Where a restore writes to. */
export interface RestoreTarget {
	/**
	 * Takes one entry back. The stream fails at its end, rather than ending,
	 * when the bytes are not the ones the backup recorded: a target that
	 * cannot undo a write keeps it apart until the stream has ended. `write`
	 * resolves only once the stream has been read to its end: `restore`
	 * refuses one that resolves sooner, since nothing was checked yet.
	 */
	write(name: string, stream: ReadableStream<Uint8Array>): Promise<void>;
}

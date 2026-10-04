import { createPublicKey } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { generateSigningKeys } from '@nxgt/backup';
import { generateIdentity, identityToRecipient } from 'age-encryption';
import { MongoBackupError } from '../errors';

/** The keys a backup job needs, all read from one file. */
export interface BackupKeys {
	/** The age secret key: to read backups, an incremental's base included. */
	identity: string;
	/** Its public half, `age1…`: every backup is encrypted to it. */
	recipient: string;
	/** The Ed25519 private key, PEM: every manifest is signed with it. */
	signingKey: string;
	/** Its public half, PEM: a manifest must be signed by it to be read. */
	publicKey: string;
}

const HEADER =
	'# @nxgt/mongo-backup key file: an age identity, then an Ed25519 signing key.\n' +
	'# Keep it secret, and keep a copy away from the backups: without it they are noise.\n';

const IDENTITY = /^AGE-SECRET-KEY-1[0-9A-Z]+$/m;
const PEM =
	/-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END PRIVATE KEY-----\n?/;

const unusable = (where: string, what: string, cause?: unknown) =>
	new MongoBackupError(
		`${where}: ${what}`,
		'KEY_FILE',
		cause === undefined ? undefined : { cause },
	);

/**
 * Writes a new key file at `path`, readable by its owner alone, synced with
 * its folder, and gives its recipient — the public half, safe to print. A
 * file already there is never overwritten: the backups made with it would
 * be lost with it. A write that fails removes the file it created.
 */
export async function generateKeyFile(
	path: string,
): Promise<{ recipient: string }> {
	const identity = await generateIdentity();
	const { privateKey } = generateSigningKeys();
	const file = await open(path, 'wx', 0o600);
	try {
		await file.writeFile(`${HEADER}${identity}\n${privateKey}`);
		await file.sync();
	} catch (error) {
		await file.close().catch(() => undefined);
		await unlink(path).catch(() => undefined);
		throw error;
	}
	await file.close();
	const folder = await open(dirname(path), 'r');
	await folder.sync().finally(() => folder.close());
	return { recipient: await identityToRecipient(identity) };
}

/**
 * The keys in the file at `path`, checked and read through one descriptor.
 * `KEY_FILE` when it is not there (the system's error as its `cause`), when
 * others than its owner can read it — as ssh refuses such a key — and when
 * it is not one `generateKeyFile` wrote; any other failure to open it is the
 * system's, as it is. No message quotes the file's content. `where` names
 * the call in messages.
 */
export async function readKeyFile(
	path: string,
	where = 'readKeyFile',
): Promise<BackupKeys> {
	const file = await open(path, 'r').catch((error: unknown) => {
		if ((error as { code?: unknown }).code !== 'ENOENT') throw error;
		throw unusable(
			where,
			'there is no key file there; write one with nxgt-mongo-backup keygen',
			error,
		);
	});
	let text: string;
	try {
		if (((await file.stat()).mode & 0o077) !== 0) {
			throw unusable(
				where,
				'others than its owner can read or write the key file; chmod 600 it',
			);
		}
		text = await file.readFile('utf8');
	} finally {
		await file.close();
	}
	return keysIn(text, where);
}

async function keysIn(text: string, where: string): Promise<BackupKeys> {
	const identity = text.match(IDENTITY)?.[0];
	const signingKey = text.match(PEM)?.[0];
	if (identity && signingKey) {
		// Either throws with the key in its message: neither is kept.
		try {
			const key = createPublicKey(signingKey);
			if (key.asymmetricKeyType !== 'ed25519') throw new Error();
			const publicKey = key.export({ type: 'spki', format: 'pem' }).toString();
			const recipient = await identityToRecipient(identity);
			return { identity, recipient, signingKey, publicKey };
		} catch {}
	}
	throw unusable(where, 'the key file is not one keygen wrote');
}

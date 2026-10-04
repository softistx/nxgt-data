import { Decrypter, Encrypter } from 'age-encryption';

/**
 * The age recipients a backup is encrypted to, checked once. A recipient
 * that age refuses is a bare `TypeError` naming its position, never the
 * key, and carrying no `cause`: age's own message can quote the string.
 */
export function checkRecipients(
	recipients: readonly string[],
	where: string,
): string[] {
	if (!Array.isArray(recipients) || recipients.length === 0) {
		throw new TypeError(
			`${where}: recipients must list at least one age public key`,
		);
	}
	const encrypter = new Encrypter();
	for (const [index, recipient] of recipients.entries()) {
		try {
			if (typeof recipient !== 'string') throw new Error();
			encrypter.addRecipient(recipient);
		} catch {
			throw new TypeError(
				`${where}: recipient ${index} is not an age public key (age1… or age1pq1…)`,
			);
		}
	}
	return [...recipients];
}

/** A fresh encrypter to `recipients`, which `checkRecipients` accepted. */
export function encrypterFor(recipients: readonly string[]): Encrypter {
	const encrypter = new Encrypter();
	for (const recipient of recipients) encrypter.addRecipient(recipient);
	return encrypter;
}

/**
 * A decrypter holding `identities`. An identity that age refuses is a bare
 * `TypeError` naming its position and nothing else: measured on
 * age-encryption 0.3.1, age's message for a bad checksum quotes the whole
 * secret key (`Invalid checksum in AGE-SECRET-KEY-1…`), so neither the
 * message nor the error itself is passed on.
 */
export function decrypterFor(
	identities: readonly string[],
	where: string,
): Decrypter {
	if (!Array.isArray(identities) || identities.length === 0) {
		throw new TypeError(
			`${where}: identities must list at least one age secret key`,
		);
	}
	const decrypter = new Decrypter();
	for (const [index, identity] of identities.entries()) {
		let accepted = false;
		try {
			if (typeof identity === 'string') {
				decrypter.addIdentity(identity);
				accepted = true;
			}
		} catch {
			// Dropped on purpose: see above.
		}
		if (!accepted) {
			throw new TypeError(
				`${where}: identity ${index} is not an age secret key (AGE-SECRET-KEY-…)`,
			);
		}
	}
	return decrypter;
}

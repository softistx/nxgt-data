import {
	createPrivateKey,
	createPublicKey,
	generateKeyPairSync,
	type KeyObject,
	sign,
	verify,
} from 'node:crypto';

/** An Ed25519 key pair, both halves as PEM text. */
export interface SigningKeys {
	/** PKCS#8 PEM, `-----BEGIN PRIVATE KEY-----`. Keep it with the writer. */
	privateKey: string;
	/** SPKI PEM, `-----BEGIN PUBLIC KEY-----`. Give it to every reader. */
	publicKey: string;
}

/**
 * A new Ed25519 key pair for signing manifests. `openssl genpkey -algorithm
 * ed25519` makes the same private key, and `openssl pkey -pubout` its
 * public half.
 */
export function generateSigningKeys(): SigningKeys {
	const pair = generateKeyPairSync('ed25519');
	return {
		privateKey: pair.privateKey.export({ type: 'pkcs8', format: 'pem' }),
		publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }),
	};
}

/**
 * The private key `create` signs with. Node's own error for a key it
 * cannot read is dropped — no message passthrough, no cause — so nothing
 * from the key text can reach a log.
 */
export function signerOf(key: unknown, where: string): KeyObject {
	let parsed: KeyObject | undefined;
	if (typeof key === 'string') {
		try {
			parsed = createPrivateKey(key);
		} catch {
			parsed = undefined;
		}
	}
	if (parsed?.asymmetricKeyType !== 'ed25519') {
		throw new TypeError(
			`${where}: signing.key is not an Ed25519 private key (PEM, PKCS#8)`,
		);
	}
	return parsed;
}

/**
 * The public keys a manifest must be signed by. A private key is refused
 * even though its public half could be derived: a reader holding it could
 * also sign.
 */
export function trustedOf(keys: unknown, where: string): KeyObject[] {
	if (!Array.isArray(keys) || keys.length === 0) {
		throw new TypeError(`${where}: trusted must list at least one public key`);
	}
	return keys.map((key: unknown, index) => {
		if (typeof key === 'string' && key.includes('PRIVATE KEY')) {
			throw new TypeError(
				`${where}: trusted ${index} is a private key; give its public key`,
			);
		}
		let parsed: KeyObject | undefined;
		if (typeof key === 'string') {
			try {
				parsed = createPublicKey(key);
			} catch {
				parsed = undefined;
			}
		}
		if (parsed?.asymmetricKeyType !== 'ed25519') {
			throw new TypeError(
				`${where}: trusted ${index} is not an Ed25519 public key (PEM, SPKI)`,
			);
		}
		return parsed;
	});
}

/** The 64-byte Ed25519 signature of `bytes`. */
export function signBytes(signer: KeyObject, bytes: Uint8Array): Uint8Array {
	return new Uint8Array(sign(null, bytes, signer));
}

/** Whether any of `trusted` signed `bytes` with `signature`. */
export function signedByAny(
	trusted: readonly KeyObject[],
	bytes: Uint8Array,
	signature: Uint8Array,
): boolean {
	if (signature.length !== 64) return false;
	return trusted.some((key) => verify(null, bytes, key, signature));
}

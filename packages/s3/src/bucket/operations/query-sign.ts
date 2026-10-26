import { amzDateOf, type PostSigner, presignedSignature } from './post-policy';

/** RFC 3986's unreserved set only: `encodeURIComponent` leaves `!'()*`. */
const encode = (value: string): string =>
	encodeURIComponent(value).replace(
		/[!'()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);

/**
 * A GET on the bucket's root, signed in its query (SigV4 "presigned URL"),
 * for the one request Bun cannot presign: a bucket-level one, such as a
 * listing.
 *
 * It signs nothing of its own: the URL is written without a signature and
 * `presignedSignature` — the function `signerOf` checks the secret with
 * against Bun's own signature, so it is known to match Bun's canonical form
 * — computes it, and it is appended. The canonical query is the pairs as
 * sent, sorted, so the values are encoded here once, RFC 3986-style, and sent
 * exactly so. `host` is the one signed header and no payload is signed.
 */
export function signedBucketGet(
	signer: PostSigner,
	query: Readonly<Record<string, string>>,
	now: Date = new Date(),
	expiresIn = 60,
): string {
	const amzDate = amzDateOf(now);
	const signing: Record<string, string> = {
		'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
		'X-Amz-Credential': `${signer.accessKeyId}/${amzDate.slice(0, 8)}/${signer.region}/s3/aws4_request`,
		'X-Amz-Date': amzDate,
		'X-Amz-Expires': String(expiresIn),
		'X-Amz-SignedHeaders': 'host',
	};
	if (signer.sessionToken) {
		signing['X-Amz-Security-Token'] = signer.sessionToken;
	}
	const pairs = Object.entries({ ...query, ...signing })
		.map(([name, value]) => [encode(name), encode(value)] as const)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
		.map(([name, value]) => `${name}=${value}`);
	const unsigned = new URL(`${signer.url}?${pairs.join('&')}`);
	const signature = presignedSignature(unsigned, 'GET', signer.secretAccessKey);
	return `${unsigned.href}&X-Amz-Signature=${signature}`;
}

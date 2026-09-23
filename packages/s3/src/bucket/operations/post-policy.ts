import { createHmac } from 'node:crypto';

/**
 * An S3 POST policy and its SigV4 signature, with nothing but `node:crypto`.
 *
 * Bun's `S3Client` signs a GET, a PUT, a HEAD and a DELETE, and has no POST
 * presigning at all; this file is that one missing signature. It is pure —
 * no client, no clock of its own — so its spec pins it at a fixed date.
 *
 * The algorithm is AWS's "browser-based upload" one: the policy is JSON,
 * base64-encoded, and the signature is the HMAC-SHA256 of **that base64
 * string** under the usual SigV4 signing key. Nothing about the request —
 * not its headers, not its body — is signed; the policy's conditions are
 * what the service holds the form to.
 */

/** One condition of a policy, in the forms S3 documents. */
export type PolicyCondition =
	| Readonly<Record<string, string>>
	| readonly ['eq' | 'starts-with', string, string]
	| readonly ['content-length-range', number, number];

/** Who signs, and where the form goes. */
export interface PostSigner {
	/** The bucket's own URL, which the form is posted to. */
	readonly url: string;
	readonly bucket: string;
	readonly accessKeyId: string;
	readonly secretAccessKey: string;
	/** As Bun signs it: `us-east-1`, `eu-west-3`, or `auto` off AWS. */
	readonly region: string;
	/** Temporary credentials: posted as `x-amz-security-token`. */
	readonly sessionToken?: string;
}

/** What the policy fixes, and until when. */
export interface PostPolicy {
	/**
	 * The form's own fields — `key`, `Content-Type`, `acl` — each one fixed
	 * by an `eq` condition, so the browser posts exactly these.
	 */
	readonly fields: Readonly<Record<string, string>>;
	/** The rest: `content-length-range`, a `starts-with`. */
	readonly conditions: readonly PolicyCondition[];
	/** Seconds from `now` until the service refuses the form. */
	readonly expiresIn: number;
	readonly now: Date;
}

/** The form a browser posts: the file goes **after** every one of `fields`. */
export interface PresignedPost {
	url: string;
	fields: Record<string, string>;
}

const ALGORITHM = 'AWS4-HMAC-SHA256';

/** `20151229T000000Z`: SigV4's own date, with no separators and no millis. */
export function amzDateOf(now: Date): string {
	return now
		.toISOString()
		.replace(/[-:]/g, '')
		.replace(/\.\d{3}/, '');
}

const hmac = (key: string | Buffer, data: string): Buffer =>
	createHmac('sha256', key).update(data).digest();

/**
 * SigV4's signing key: four HMACs, from the secret down to `aws4_request`.
 * The service is a parameter only so the spec can pin this against AWS's
 * own documented vector, which is for `iam`.
 */
export function signingKey(
	secretAccessKey: string,
	day: string,
	region: string,
	service = 's3',
): Buffer {
	const date = hmac(`AWS4${secretAccessKey}`, day);
	return hmac(hmac(hmac(date, region), service), 'aws4_request');
}

/** Signs a policy, and gives back the whole form but the file. */
export function signPostPolicy(
	signer: PostSigner,
	policy: PostPolicy,
): PresignedPost {
	const amzDate = amzDateOf(policy.now);
	const day = amzDate.slice(0, 8);
	const signing: Record<string, string> = {
		'x-amz-algorithm': ALGORITHM,
		'x-amz-credential': `${signer.accessKeyId}/${day}/${signer.region}/s3/aws4_request`,
		'x-amz-date': amzDate,
	};
	if (signer.sessionToken) {
		signing['x-amz-security-token'] = signer.sessionToken;
	}
	const fields = { ...policy.fields, ...signing };
	const document = {
		expiration: new Date(
			policy.now.getTime() + policy.expiresIn * 1000,
		).toISOString(),
		conditions: [
			{ bucket: signer.bucket },
			...Object.entries(fields).map(([name, value]) => [
				'eq',
				`$${name}`,
				value,
			]),
			...policy.conditions,
		],
	};
	const encoded = Buffer.from(JSON.stringify(document)).toString('base64');
	const signature = createHmac(
		'sha256',
		signingKey(signer.secretAccessKey, day, signer.region),
	)
		.update(encoded)
		.digest('hex');
	return {
		url: signer.url,
		fields: { ...fields, policy: encoded, 'x-amz-signature': signature },
	};
}

import { type BucketContext, secretOf } from '../context';
import type { PostSigner } from './post-policy';

/**
 * Where Bun would send this bucket's requests, and as whom.
 *
 * Read off a URL Bun itself signs, rather than worked out again here:
 * measured on bun 1.4.2, Bun signs for region `auto` at any endpoint that is
 * not AWS's, reads the region out of an AWS hostname, falls back to
 * `us-east-1`, and puts the bucket in the path or the host by
 * `virtualHostedStyle`. A second copy of those rules would drift from the
 * first; this way a POST goes wherever a presigned PUT goes. The probe key is
 * signed and thrown away — nothing is sent.
 */
export const PROBE = 'nxgt-probe';

/** `accessKeyId/20260923/us-east-1/s3/aws4_request`, as its five parts. */
const SCOPE_PARTS = 5;

export function signerOf<P>(context: BucketContext<P>): PostSigner {
	const call = `presignPost on "${context.definition.bucket}"`;
	// Bun's own `ERR_S3_MISSING_CREDENTIALS` comes out of here when there are
	// no credentials at all, as it does for `presignPut`.
	const probe = new URL(
		context.client.presign(PROBE, { method: 'PUT', expiresIn: 1 }),
	);
	const scope = (probe.searchParams.get('X-Amz-Credential') ?? '').split('/');
	if (scope.length < SCOPE_PARTS || !probe.pathname.endsWith(PROBE)) {
		// Only a Bun that signs differently from 1.4.2 reaches this: better a
		// refusal than a form posted to the wrong place or signed as nobody.
		throw new Error(
			`${call}: the URL Bun signed has no credential scope, or not the key ` +
				'at the end of its path, so there is nowhere to post the form. ' +
				'This Bun signs differently from the one this package was measured on',
		);
	}
	const secretAccessKey = secretOf(context);
	if (!secretAccessKey) {
		// Not reachable through `bindBucket`: the context resolves the same
		// option and the same two variables Bun does, when the client is made,
		// so Bun's error above comes first. It guards a context built any
		// other way.
		throw new TypeError(
			`${call}: no secret access key to sign with. Pass ` +
				'`secretAccessKey` to bindBucket, or set S3_SECRET_ACCESS_KEY ' +
				'or AWS_SECRET_ACCESS_KEY',
		);
	}
	return {
		url: `${probe.origin}${probe.pathname.slice(0, -PROBE.length)}`,
		bucket: context.definition.bucket,
		accessKeyId: scope.slice(0, -4).join('/'),
		region: scope.at(-3) as string,
		secretAccessKey,
		sessionToken: probe.searchParams.get('X-Amz-Security-Token') ?? undefined,
	};
}

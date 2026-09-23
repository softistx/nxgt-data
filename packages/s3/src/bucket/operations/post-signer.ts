import { type BucketContext, callOf, secretOf } from '../context';
import { type PostSigner, presignedSignature, rawQueryOf } from './post-policy';

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

/** The query of a URL Bun signed, or `undefined` when it cannot be read. */
const queryOf = (url: URL) => rawQueryOf(url.search.slice(1).split('&'));

/**
 * The secret this bucket signs with — **the one Bun signs with**, or a
 * refusal.
 *
 * The context resolves it from the option, then `S3_SECRET_ACCESS_KEY`, then
 * `AWS_SECRET_ACCESS_KEY`, as Bun documents — but Bun reads those variables
 * **once, when the process starts** (measured by the review of this code),
 * and the context reads them when the bucket is bound. A variable changed or
 * deleted in between gives the two different secrets: the form would be
 * signed with one and refused by the service only when a browser posts it.
 * So the secret is checked against the signature Bun put on the probe.
 */
function checkedSecret<P>(context: BucketContext<P>, probe: URL): string {
	const call = callOf(context, 'presignPost');
	const secret = secretOf(context);
	if (!secret) {
		throw new TypeError(
			`${call}: no secret access key to sign with, while Bun has one. ` +
				'Bun reads S3_SECRET_ACCESS_KEY and AWS_SECRET_ACCESS_KEY when the ' +
				'process starts; one removed since is still Bun’s, and no longer ' +
				'this package’s. Pass `secretAccessKey` to bindBucket',
		);
	}
	const signed = queryOf(probe)?.get('X-Amz-Signature');
	if (presignedSignature(probe, 'PUT', secret) !== signed) {
		throw new TypeError(
			`${call}: the secret access key this package would sign with is not ` +
				'the one Bun signs with, so the service would refuse the form. Bun ' +
				'reads S3_SECRET_ACCESS_KEY and AWS_SECRET_ACCESS_KEY when the ' +
				'process starts; one changed since is not the one Bun uses. Pass ' +
				'`secretAccessKey` to bindBucket',
		);
	}
	return secret;
}

export function signerOf<P>(context: BucketContext<P>): PostSigner {
	// Bun's own `ERR_S3_MISSING_CREDENTIALS` comes out of here when Bun has no
	// credentials at all, as it does for `presignPut`.
	const probe = new URL(
		context.client.presign(PROBE, { method: 'PUT', expiresIn: 1 }),
	);
	const query = queryOf(probe);
	const scope = (query?.get('X-Amz-Credential') ?? '').split('/');
	if (!query || scope.length < SCOPE_PARTS || !probe.pathname.endsWith(PROBE)) {
		// Only a Bun that signs differently from 1.4.2 reaches this — or an
		// access key id with a `%` Bun left unescaped: better a refusal than a
		// form posted to the wrong place or signed as nobody.
		throw new Error(
			`${callOf(context, 'presignPost')}: the URL Bun signed has no ` +
				'credential scope, or not the key at the end of its path, so there ' +
				'is nowhere to post the form. This Bun signs differently from the ' +
				'one this package was measured on',
		);
	}
	return {
		url: `${probe.origin}${probe.pathname.slice(0, -PROBE.length)}`,
		bucket: context.definition.bucket,
		accessKeyId: scope.slice(0, -4).join('/'),
		region: scope.at(-3) as string,
		secretAccessKey: checkedSecret(context, probe),
		sessionToken: query.get('X-Amz-Security-Token'),
	};
}

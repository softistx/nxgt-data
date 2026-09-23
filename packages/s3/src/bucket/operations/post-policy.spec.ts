import { describe, expect, test } from 'bun:test';
import {
	amzDateOf,
	type PostSigner,
	signingKey,
	signPostPolicy,
} from './post-policy';

// No server: the signature is a pure function of these, pinned at a fixed
// date. That it is the signature a real service accepts is proved by
// `presign-post.spec.ts`, against SeaweedFS.
const signer: PostSigner = {
	url: 'http://127.0.0.1:9000/avatars',
	bucket: 'avatars',
	accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
	secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
	region: 'us-east-1',
};
const now = new Date('2015-12-29T00:00:00.000Z');

const decoded = (policy: string | undefined) =>
	JSON.parse(Buffer.from(policy ?? '', 'base64').toString('utf8'));

describe('the SigV4 signing key', () => {
	test('is the one AWS documents, byte for byte', () => {
		// AWS's own worked example of deriving a signing key: this secret,
		// 20120215, us-east-1, iam. Both the first step and the last are
		// published, so a wrong HMAC order fails here, not at an upload.
		const secret = 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY';
		expect(
			signingKey(secret, '20120215', 'us-east-1', 'iam').toString('hex'),
		).toBe('f4780e2d9f65fa895f9c67b32ce1baf0b0d8a43505a000a1a9e090d414db404d');
	});

	test('dates the request the way SigV4 writes a date', () => {
		expect(amzDateOf(now)).toBe('20151229T000000Z');
		expect(amzDateOf(new Date('2026-09-23T04:27:41.123Z'))).toBe(
			'20260923T042741Z',
		);
	});
});

describe('a signed POST policy', () => {
	const signed = () =>
		signPostPolicy(signer, {
			fields: { key: 'u1.png', 'Content-Type': 'image/png' },
			conditions: [['content-length-range', 0, 1024]],
			expiresIn: 3600,
			now,
		});

	test('posts to the signer’s URL, with the form fields and the signing ones', () => {
		const form = signed();
		expect(form.url).toBe('http://127.0.0.1:9000/avatars');
		expect(Object.keys(form.fields)).toEqual([
			'key',
			'Content-Type',
			'x-amz-algorithm',
			'x-amz-credential',
			'x-amz-date',
			'policy',
			'x-amz-signature',
		]);
		expect(form.fields['x-amz-credential']).toBe(
			'AKIAIOSFODNN7EXAMPLE/20151229/us-east-1/s3/aws4_request',
		);
		expect(form.fields['x-amz-date']).toBe('20151229T000000Z');
	});

	test('fixes every field it hands out, the bucket, and the range', () => {
		expect(decoded(signed().fields.policy)).toEqual({
			expiration: '2015-12-29T01:00:00.000Z',
			conditions: [
				{ bucket: 'avatars' },
				['eq', '$key', 'u1.png'],
				['eq', '$Content-Type', 'image/png'],
				['eq', '$x-amz-algorithm', 'AWS4-HMAC-SHA256'],
				[
					'eq',
					'$x-amz-credential',
					'AKIAIOSFODNN7EXAMPLE/20151229/us-east-1/s3/aws4_request',
				],
				['eq', '$x-amz-date', '20151229T000000Z'],
				['content-length-range', 0, 1024],
			],
		});
	});

	test('is deterministic: the same inputs, the same signature', () => {
		// Pinned: a change to the policy's bytes or to the HMAC chain changes
		// this, and the SeaweedFS spec says whether the new one is accepted.
		expect(signed().fields['x-amz-signature']).toBe(SIGNATURE);
		expect(signed()).toEqual(signed());
	});

	test('expires `expiresIn` seconds after the clock it is given', () => {
		const later = signPostPolicy(signer, {
			fields: { key: 'k' },
			conditions: [],
			expiresIn: 1,
			now: new Date('2026-01-01T00:00:00.000Z'),
		});
		expect(decoded(later.fields.policy).expiration).toBe(
			'2026-01-01T00:00:01.000Z',
		);
	});

	test('carries a session token as a field the policy fixes too', () => {
		const form = signPostPolicy(
			{ ...signer, sessionToken: 'a-token' },
			{ fields: { key: 'k' }, conditions: [], expiresIn: 60, now },
		);
		expect(form.fields['x-amz-security-token']).toBe('a-token');
		expect(decoded(form.fields.policy).conditions).toContainEqual([
			'eq',
			'$x-amz-security-token',
			'a-token',
		]);
	});
});

const SIGNATURE =
	'039472a83591edf14da2856a4bba914f548a17b6eea03403c24f21f2ccf7c6a5';

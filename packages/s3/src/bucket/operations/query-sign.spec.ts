import { describe, expect, test } from 'bun:test';
import type { S3Client } from 'bun';
import { avatars } from '../../../test/fixtures';
import { bindBucket } from '../bind-bucket';
import { bucketContext } from '../context';
import { presignedSignature } from './post-policy';
import { signerOf } from './post-signer';
import { signedBucketGet } from './query-sign';

// No server: the shape of a signed GET on the bucket's root. SeaweedFS
// accepts it in `deadline-store.spec.ts`, which is the proof it is valid.
const signer = {
	url: 'http://127.0.0.1:9000/avatars/',
	bucket: 'avatars',
	accessKeyId: 'a+key/id',
	secretAccessKey: 'not-a-secret',
	region: 'auto',
};
const now = new Date('2026-10-26T01:02:03.456Z');

describe('a signed GET on the bucket’s root', () => {
	test('its pairs are sorted by encoded name, values RFC 3986-encoded', () => {
		const url = new URL(
			signedBucketGet(
				signer,
				{ 'list-type': '2', prefix: "a b+c/é!'()*&=", 'max-keys': '5' },
				now,
			),
		);
		expect(url.origin + url.pathname).toBe('http://127.0.0.1:9000/avatars/');
		const names = url.search
			.slice(1)
			.split('&')
			.map((pair) => pair.split('=')[0]);
		expect(names).toEqual([
			'X-Amz-Algorithm',
			'X-Amz-Credential',
			'X-Amz-Date',
			'X-Amz-Expires',
			'X-Amz-SignedHeaders',
			'list-type',
			'max-keys',
			'prefix',
			'X-Amz-Signature',
		]);
		expect(url.search).toContain(
			'prefix=a%20b%2Bc%2F%C3%A9%21%27%28%29%2A%26%3D&',
		);
		expect(url.search).toContain('X-Amz-Date=20261026T010203Z');
		expect(url.search).toContain('X-Amz-Expires=60');
		expect(url.search).toContain(
			'X-Amz-Credential=a%2Bkey%2Fid%2F20261026%2Fauto%2Fs3%2Faws4_request',
		);
	});

	test('its signature is the one the canonical request gives, and not another secret’s', () => {
		const url = new URL(signedBucketGet(signer, { 'list-type': '2' }, now));
		const signed = url.searchParams.get('X-Amz-Signature');
		expect(signed).toMatch(/^[0-9a-f]{64}$/);
		expect(presignedSignature(url, 'GET', signer.secretAccessKey)).toBe(
			signed as string,
		);
		expect(presignedSignature(url, 'GET', 'another')).not.toBe(
			signed as string,
		);
	});

	test('a session token is signed in, and the expiry is the one asked', () => {
		const url = signedBucketGet(
			{ ...signer, sessionToken: 'tok/en+' },
			{ 'list-type': '2' },
			now,
			30,
		);
		expect(url).toContain('X-Amz-Security-Token=tok%2Fen%2B');
		expect(url).toContain('X-Amz-Expires=30');
	});
});

const MARKER = 'nxgt-marker-not-a-secret';

describe('the signer a listing uses', () => {
	test('a listing’s refusals name `list`, and a secret that is not Bun’s the request', async () => {
		const bucket = bindBucket(avatars, {
			endpoint: 'http://127.0.0.1:9000',
			accessKeyId: 'a-key-id',
			secretAccessKey: MARKER,
		});
		// A secret other than the one Bun signed the probe with.
		const other = bucketContext(bucket.client, avatars, 'another-secret');
		expect(() => signerOf(other, 'list')).toThrow(
			'list on "avatars": the secret access key this package would sign ' +
				'with is not the one Bun signs with, so the service would refuse the request.',
		);
		const url = `http://127.0.0.1:9000/avatars/elsewhere?X-Amz-Credential=k`;
		const unreadable = bucketContext(
			{ presign: () => url } as unknown as S3Client,
			avatars,
			MARKER,
		);
		expect(() => signerOf(unreadable, 'list')).toThrow(
			'list on "avatars": the URL Bun signed has no credential scope, or not the key at the end of its path, so there is nowhere to send the request.',
		);
	});
});

import { describe, expect, test } from 'bun:test';
import { parseListing } from './list-xml';

// No server: what a ListObjectsV2 answer is read as. The listing spec holds
// the same reading against SeaweedFS.
describe('a listing answer, read without a parser', () => {
	test('the keys, sizes, times and tags of a truncated page', () => {
		const answer = parseListing(
			'<?xml version="1.0"?><ListBucketResult><Name>b</Name>' +
				'<IsTruncated>true</IsTruncated>' +
				'<NextContinuationToken>tok</NextContinuationToken>' +
				'<Contents><Key>a.png</Key><LastModified>2026-10-26T02:09:19Z</LastModified>' +
				'<ETag>&#34;abc&#34;</ETag><Size>12</Size></Contents>' +
				'<Contents><Key>b.png</Key></Contents></ListBucketResult>',
		);
		expect(answer).toEqual({
			contents: [
				{
					key: 'a.png',
					size: 12,
					lastModified: '2026-10-26T02:09:19Z',
					eTag: '"abc"',
				},
				{
					key: 'b.png',
					size: undefined,
					lastModified: undefined,
					eTag: undefined,
				},
			],
			isTruncated: true,
			nextContinuationToken: 'tok',
		});
	});

	test('text is unescaped once: the five names and numeric references', () => {
		const answer = parseListing(
			'<ListBucketResult><IsTruncated>false</IsTruncated><Contents>' +
				'<Key>a&amp;b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#233;&#x1F600; &amp;lt;</Key>' +
				'</Contents></ListBucketResult>',
		);
		expect(answer.contents[0]?.key).toBe('a&b <c> "d" \'e\' é😀 &lt;');
		expect(answer.isTruncated).toBe(false);
		expect(answer.nextContinuationToken).toBeUndefined();
	});

	test('a key that spells a tag is a key, not the answer’s own fields', () => {
		const answer = parseListing(
			'<ListBucketResult><IsTruncated>false</IsTruncated><Contents>' +
				'<Key>&lt;IsTruncated&gt;true&lt;/IsTruncated&gt;</Key></Contents>' +
				'</ListBucketResult>',
		);
		expect(answer.contents[0]?.key).toBe('<IsTruncated>true</IsTruncated>');
		expect(answer.isTruncated).toBe(false);
	});

	test('an empty bucket is an empty page', () => {
		expect(
			parseListing(
				'<ListBucketResult><KeyCount>0</KeyCount></ListBucketResult>',
			),
		).toEqual({
			contents: [],
			isTruncated: false,
			nextContinuationToken: undefined,
		});
	});

	test('an XML declaration and a byte order mark may come first', () => {
		for (const head of [
			'<?xml version="1.0" encoding="UTF-8"?>\n',
			'\uFEFF',
			'',
		]) {
			expect(
				parseListing(`${head}<ListBucketResult xmlns="x"></ListBucketResult>`)
					.contents,
			).toEqual([]);
		}
	});

	test('an answer that is not a ListBucketResult is refused, not an empty bucket', () => {
		for (const body of [
			'<Error><Code>AccessDenied</Code><Message>no</Message></Error>',
			'<!doctype html><html><body>502 Bad Gateway</body></html>',
			'',
			'<?xml version="1.0"?><ListAllMyBucketsResult></ListAllMyBucketsResult>',
			'<ListBucketResultX></ListBucketResultX>',
		]) {
			let thrown: unknown;
			try {
				parseListing(body);
			} catch (error) {
				thrown = error;
			}
			const error = thrown as Error & { code: string; path: string };
			expect(error.name).toBe('S3Error');
			expect(error.code).toBe('InvalidResponse');
			expect(error.path).toBe('');
			expect(error.message).toBe(
				'ListObjectsV2 response is not a well-formed <ListBucketResult> document',
			);
		}
	});

	test('CDATA is its text, as it is, and not unescaped again', () => {
		const answer = parseListing(
			'<ListBucketResult><Contents><Key><![CDATA[a&amp;b <c>]]>&amp;</Key>' +
				'</Contents></ListBucketResult>',
		);
		expect(answer.contents[0]?.key).toBe('a&amp;b <c>&');
	});

	test('a numeric reference XML forbids is a malformed answer', () => {
		for (const ref of [
			'&#0;',
			'&#x0;',
			'&#1;',
			'&#xB;',
			'&#xD800;',
			'&#xFFFE;',
			'&#x110000;',
		]) {
			expect(() =>
				parseListing(
					`<ListBucketResult><Contents><Key>a${ref}</Key></Contents></ListBucketResult>`,
				),
			).toThrow('not a well-formed <ListBucketResult> document');
		}
		const ok = parseListing(
			'<ListBucketResult><Contents><Key>a&#9;&#xA;&#xD;&#x20;&#xFFFD;&#x10000;</Key></Contents></ListBucketResult>',
		);
		expect(ok.contents[0]?.key).toBe('a\t\n\r \uFFFD\u{10000}');
	});

	test('a Size that is not a finite number is unknown', () => {
		const answer = parseListing(
			'<ListBucketResult><Contents><Key>a</Key><Size>abc</Size></Contents>' +
				'<Contents><Key>b</Key><Size>Infinity</Size></Contents></ListBucketResult>',
		);
		expect(answer.contents.map((found) => found.size)).toEqual([
			undefined,
			undefined,
		]);
	});
});

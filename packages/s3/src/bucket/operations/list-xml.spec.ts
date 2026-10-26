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
});

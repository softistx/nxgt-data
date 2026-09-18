# @nxgt/s3

## 0.1.0

### Minor Changes

- [#47](https://github.com/softistx/nxgt-data/pull/47) [`8f2d234`](https://github.com/softistx/nxgt-data/commit/8f2d234ca87f54dc1ab038cc1565f8a3f683ce97) Thanks [@SteveGT96](https://github.com/SteveGT96)! - S3 on Bun's own `S3Client`, with no AWS SDK: `defineBucket` names the bucket,
  the function that builds an object's key, the content types it accepts and the
  biggest body it takes; `bindBucket` gives `put`, `bytes`, `text`, `exists`,
  `stat`, `delete`, a `list` in this repository's cursor shape, and
  `presignGet` / `presignPut` from the same definition. The content type and the
  size are checked **before** the request goes out. Its one error is `S3Error`.

---
"@nxgt/backup": minor
---

An S3 repository: `s3Repository({ client, prefix, partSize })` keeps backups in any S3-compatible bucket through your own Bun `S3Client`, beside or instead of a local folder. Up to 64 MiB an object goes in one PUT, visible whole or not at all; a larger one is streamed from disk in parts. Every write reads the stored size back before it counts as done. Restores and verifies now stop reading an object as soon as it runs past the size its manifest gives, from any repository.

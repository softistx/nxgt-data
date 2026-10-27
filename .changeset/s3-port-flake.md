---
'@nxgt/s3': patch
---

`startTestS3`: two servers started at the same time could be handed overlapping port blocks, so one died with `bind: address already in use` on a gRPC port. A block is now claimed before it is probed and given back on `stop()`.

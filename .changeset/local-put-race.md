---
"@nxgt/backup": patch
---

`localRepository`: a `put` racing a `delete` of its folder retries on `ENOENT` anywhere on the way, and up to five times. Before, it retried only when the folder was gone at the moment of the check, so a race lost while another `put` had made the folder again failed the write.

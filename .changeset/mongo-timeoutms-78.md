---
'@nxgt/mongo': patch
---

Document that mongodb 7.8 ignores `timeoutMS`: a transaction retrying a deterministic collision always runs the driver's full 120-second window, and `ping` reports a slow server through its own timer (`ConnectionError`). The GridFS transactional-collision spec no longer relies on `timeoutMS`, which left it looping under mongodb 7.8 and timed out the specs after it (#308).

---
---

Specs only: nothing a consumer installs changes.

The specs that watch a promise reject now take that rejection up when the
promise is made, and not after the line that causes it. A rejection nothing is
yet waiting for is an unhandled one, and the test then fails with the very
error it came to assert — which is what a loaded CI runner showed.

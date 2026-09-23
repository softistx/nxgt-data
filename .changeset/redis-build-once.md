---
---

The root `test` script builds the test Redis once before the packages' suites run in parallel; three concurrent builds on a cold cache broke each other on CI. No package changes.

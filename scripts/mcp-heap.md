# MCP retained-heap regression

Run `npm ci && npm run test:heap` (Node with `--expose-gc` is required).
The test creates an isolated empty vault and uses a dummy classifier key; it makes
no classifier calls. It consumes real stateless HTTP MCP SSE response bodies via
Hono's Fetch interface: 100 warm-up initialize/tools-list pairs, then three batches
of 1,000 pairs. After each batch it yields and forces GC twice, printing heap bytes.
Growth over warm-up must remain below 16 MiB. This is opt-in rather than part of
parallel Vitest CI to avoid noisy heap measurements. It measures retained JS heap,
not socket/RSS behavior or arbitrarily long SSE requests.

For a short comparison use `HEAP_WARMUP=20 HEAP_BATCH=50 npm run test:heap`.
The same script on origin/main with Zod 3.25.76 fails: its bundled v4 global
metadata registry strongly retains every `.describe()` schema created per HTTP
request. Zod 4 uses a WeakMap for schema metadata, allowing completed request
servers and schemas to be collected. Do not clear the global registry per request:
that would erase metadata belonging to concurrent requests.

Transport/body cleanup remains unchanged, as do stateless HTTP behavior and the
bounded dashboard authentication maps. No session TTL is needed for stateless MCP.

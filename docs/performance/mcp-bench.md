# HTTP MCP efficiency benchmark

Base: main after #96, 552b8640e5c8ba0e4f4ac470110f9a8444afac42 (Zod 4.6.7).
No server reuse, schema, auth, deployment configuration, or heap-limit changes.

## Reproduce

```sh
npm ci
npm run build
npm run test:bench
# Optional: BENCH_REQUESTS=24000 BENCH_CONCURRENCY=8 npm run test:bench
npm run test:heap
docker build -t granite-bench .
docker image inspect granite-bench --format '{{.Size}}'
```

To measure baseline, copy only scripts/mcp-bench* and the test:bench npm script
to a separate worktree at the base SHA, install and build there. Do not copy
the extraction change. Run baseline and head sequentially on the same host.

The harness launches the built CLI in a separate Node process, with an IPC-only
sampler preloaded. A temporary empty default vault is removed afterward.
The placeholder classifier key never makes network calls: tools/call invokes
granite_vault_types. Document parsing remains enabled; no feature toggles.
12,000 requests, concurrency 4, equally split between initialize, tools/list,
and tools/call; all JSON-RPC results and tool success are checked.
Startup includes process spawn, imports and the first successful initialize
response, polled every 20 ms. Idle is sampled two seconds after that response.
Memory is sampled every 100 ms without forced GC; load peaks are observed
samples, not exact maxima or retained-heap measurements. CPU is child process
user + system CPU delta between acknowledged snapshots bracketing load;
percentage divides by the child monotonic snapshot interval and uses one logical core as 100% (can exceed 100%). Latency includes
HTTP roundtrip, response body consumption and validation. Client overhead
is excluded from server memory and CPU. No production instrumentation is added.

These are single-run observations, not statistical guarantees. Empty-vault
read-only load does not represent large vault searches, writes, parsing, or
classifier network latency. Lazy imports defer parser startup cost to first
DOCX/XLSX extraction; after parsing, Node retains modules normally. Existing
extraction tests cover those paths. No claim of latency or image improvement.

## Decisions (gain / risk)

1. **Shipped: lazy Mammoth + SheetJS imports** — high idle RAM gain / low risk.
   Parsers are only needed for DOCX/XLSX; existing functions are already async.
   Native ESM caches imports; no custom cache or concurrency state.
2. **Deferred: reuse MCP server/schemas** — potentially high load CPU/RAM gain /
   high lifecycle, role isolation and post-#96 retention risk. No change without
   dedicated leak/concurrency evidence.
3. **Deferred: distroless/bundling/dependency removal** — uncertain image gain /
   native SQLite, CJS parser and entrypoint compatibility risk. Both parsers
   remain required features; lazy loading does not remove installed bytes.
4. **Deferred: SQLite tuning/caches** — no evidence this workload is DB-bound;
   would change invalidation/durability tradeoffs without measured justification.

## Results

See results.json for complete raw output and the comparison below.
Docker sizes are actual docker image inspect .Size bytes (not compressed
registry transfer size). Dockerfile unchanged. Runtime base is Node 22;
host benchmark uses Node 24.22.1, so these are not Node 22 container timings.
Sandbox: Linux x64, AMD EPYC 4585PX, 4 visible logical CPUs, 7941 MiB
visible RAM; shared cloud host, not CPU-pinned. Other host tenants can add noise.

| Metric | Baseline | After |
|---|---:|---:|
| Startup ms | 263.83 | 215.63 |
| Idle RSS MiB | 133.12 | 106.57 |
| Idle heap MiB | 48.33 | 21.95 |
| Load peak RSS MiB | 526.73 | 467.15 |
| Load peak heap MiB | 298.20 | 236.82 |
| Load wall ms | 25354.24 | 23568.49 |
| Load CPU ms | 38515.71 | 35059.44 |
| CPU % one core | 151.91 | 148.75 |
| initialize p50 ms | 5.69 | 5.98 |
| initialize p95 ms | 20.87 | 19.89 |
| tools/list p50 ms | 7.40 | 6.29 |
| tools/list p95 ms | 22.52 | 19.58 |
| tools/call p50 ms | 7.66 | 7.40 |
| tools/call p95 ms | 23.31 | 20.99 |
| Docker image bytes | 102467560.00 | 102467587.00 |

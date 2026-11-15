import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { writeDefaultConfig } from '../src/core/config.js';

const count = Number(process.env.BENCH_REQUESTS ?? 12000);
const concurrency = Number(process.env.BENCH_CONCURRENCY ?? 4);
assert(Number.isInteger(count) && count > 0 && Number.isInteger(concurrency) && concurrency > 0);
const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-bench-'));
writeDefaultConfig(vault);
// Reserve an ephemeral port; the small close/bind race fails loudly.
const probe = createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = (probe.address() as { port: number }).port;
await new Promise<void>(resolve => probe.close(() => resolve()));
type Sample = { id?: number; time?: number; memory: { rss: number; heapUsed: number }; cpu: { user: number; system: number } };
let latest: Sample | undefined;
let samples: Sample[] = [];
const started = performance.now();
const child = fork(path.resolve('dist/index.js'), ['mcp', '--vault', vault, '--transport', 'http', '--host', '127.0.0.1', '--port', String(port), '--json-response', '--auth-token', 'local-benchmark-token'], {
  execArgv: ['--import', path.resolve('scripts/mcp-bench-sampler.mjs')],
  env: { ...process.env, TYPESAFE_API_KEY: 'local-benchmark-placeholder', GRANITE_DISABLE_DOCUMENT_PARSING: '0', GRANITE_MCP_DAEMONIZED: '0' },
  stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
});
child.on('message', value => { latest = value as Sample; samples.push(latest); });
let snapshotId = 0;
async function snapshot(): Promise<Sample> {
  const id = ++snapshotId;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off('message', receive); reject(new Error('Sampler timeout')); }, 5000);
    function receive(value: unknown) {
      const sample = value as Sample;
      if (sample.id !== id) return;
      clearTimeout(timer);
      child.off('message', receive);
      resolve(sample);
    }
    child.on('message', receive);
    child.send(id);
  });
}
const requests = [
  ['initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bench', version: '1' } }],
  ['tools/list', {}],
  ['tools/call', { name: 'granite_vault_types', arguments: {} }],
] as const;
const latencies: Record<string, number[]> = {};
async function request(index: number, record = false) {
  const [method, params] = requests[index % requests.length];
  const start = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST', headers: { authorization: 'Bearer local-benchmark-token', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: index, method, params }), signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  const body = await response.json() as { result?: { isError?: boolean }; error?: unknown };
  assert(!body.error && body.result && !body.result.isError, 'MCP request failed');
  if (record) (latencies[method] ??= []).push(performance.now() - start);
}
try {
  while (true) {
    try { await request(0); break; } catch (error) {
      if (child.exitCode !== null || performance.now() - started > 30000) throw error;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  const startupMs = performance.now() - started;
  await new Promise(resolve => setTimeout(resolve, 2000));
  const idle = await snapshot();
  samples = [];
  const loadStart = performance.now();
  let next = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (next < count) await request(next++, true);
  }));
  const loadMs = performance.now() - loadStart;
  const end = await snapshot();
  const cpuIntervalMs = end.time! - idle.time!;
  const cpuMs = (end.cpu.user + end.cpu.system - idle.cpu.user - idle.cpu.system) / 1000;
  const mib = (bytes: number) => +(bytes / 1048576).toFixed(2);
  console.log(JSON.stringify({
    node: process.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0].model,
    logicalCpus: os.cpus().length, totalMemoryMiB: mib(os.totalmem()), count, concurrency, startupMs,
    idle: { rssMiB: mib(idle.memory.rss), heapMiB: mib(idle.memory.heapUsed) },
    loadPeak: { rssMiB: mib(Math.max(...samples.map(s => s.memory.rss))), heapMiB: mib(Math.max(...samples.map(s => s.memory.heapUsed))) },
    loadMs, cpuIntervalMs, cpuMs, cpuPercentOneCore: cpuMs / cpuIntervalMs * 100,
    latencyMs: Object.fromEntries(Object.entries(latencies).map(([method, values]) => {
      values.sort((a, b) => a - b);
      return [method, { count: values.length, p50: values[Math.ceil(values.length * .5) - 1], p95: values[Math.ceil(values.length * .95) - 1] }];
    })),
  }, null, 2));
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill();
    await exited;
  }
  fs.rmSync(vault, { recursive: true, force: true });
}

// Run: node --expose-gc --import tsx scripts/mcp-heap.ts
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { writeDefaultConfig } from '../src/core/config.js';
import { GraniteMcpRuntime } from '../src/mcp/runtime.js';
import { createGraniteMcpHttpApp } from '../src/mcp/server.js';
assert(global.gc, 'Run with --expose-gc');
process.env.TYPESAFE_API_KEY = 'local-test-placeholder';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-heap-'));
writeDefaultConfig(dir);
const runtime = new GraniteMcpRuntime(dir);
const app = createGraniteMcpHttpApp(runtime, { host: 'localhost', port: 3000 });
async function batch(count: number) {
  for (let i = 0; i < count; i++) {
    for (const [method, params] of [
      ['initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'heap-test', version: '1' } }],
      ['tools/list', {}],
    ] as const) {
      const response = await app.request('http://localhost:3000/mcp', {
        method: 'POST', headers: { host: 'localhost:3000', 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: i, method, params }),
      });
      assert.equal(response.status, 200);
      await response.text();
    }
  }
}
async function heap() {
  await new Promise(resolve => setTimeout(resolve, 50));
  global.gc!(); global.gc!();
  return process.memoryUsage().heapUsed;
}
try {
  await batch(Number(process.env.HEAP_WARMUP ?? 100));
  const baseline = await heap();
  const samples = [baseline];
  for (let i = 0; i < 3; i++) { await batch(Number(process.env.HEAP_BATCH ?? 1000)); samples.push(await heap()); console.log(JSON.stringify({ samples })); }
  assert(samples.at(-1)! - baseline < 16 * 1024 * 1024, 'Retained heap grew by more than 16 MiB after warm-up');
} finally { runtime.close(); fs.rmSync(dir, { recursive: true, force: true }); }

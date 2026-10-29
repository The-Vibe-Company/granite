import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { beforeEach, afterEach, expect, it } from 'vitest';
import { writeDefaultConfig } from '../../src/core/config.js';

const root = path.resolve(import.meta.dirname, '../..');
let tmp: string;
let vault: string;
let remote: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-migrate-test-'));
  vault = path.join(tmp, 'source');
  remote = path.join(tmp, 'remote');
  fs.mkdirSync(vault);
  fs.mkdirSync(remote);
  writeDefaultConfig(vault);
  fs.mkdirSync(path.join(vault, 'notes/notes'), { recursive: true });
  fs.writeFileSync(path.join(vault, 'notes/notes/one.md'), '---\nid: stable-id\n---\nOriginal content');
  fs.mkdirSync(path.join(vault, 'assets'));
  fs.writeFileSync(path.join(vault, 'assets/photo.png'), Buffer.from([0, 255, 12]));
  fs.writeFileSync(path.join(vault, 'sync.json'), 'private-local-token');
  fs.writeFileSync(path.join(vault, 'notes/notes/.env'), 'private-secret');
  fs.writeFileSync(path.join(remote, 'old-note.md'), 'preserved remote');
  // Provider boundary fixture implements filesystem transfer, not migration policy.
  fs.writeFileSync(path.join(tmp, 'railway'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), tmp = process.env.FAKE_ROOT;
const fail = () => { console.error('private-provider-secret'); process.exit(1); };
fs.appendFileSync(path.join(tmp, 'calls'), JSON.stringify(args) + '\\n');
const variables = { RAILWAY_VOLUME_MOUNT_PATH:'/vault', GRANITE_VAULT:'/vault', GRANITE_MCP_TOKEN:null, TYPESAFE_API_KEY:null };
if (args[0] === 'variable' && args[1] === 'list') { if (process.env.SCENARIO === 'missing-key') delete variables.TYPESAFE_API_KEY; console.log(JSON.stringify(variables)); }
else if (args[0] === 'ssh') { if (process.env.SCENARIO === 'old-runtime') fail(); console.log(JSON.stringify({capability:'granite-railway-migration-v1',mount:'/vault',vault:'/vault',service:'granite',volume:'data'})); }
else if (args[0] === 'volume' && args.includes('list')) console.log(JSON.stringify({volumes:[{id:'volume-id',name:'data',serviceName:'granite',mountPath:'/vault'}]}));
else if (args[0] === 'volume') {
  if (args[args.indexOf('--volume') + 1] !== 'volume-id') fail();
  const action = args.includes('upload') ? 'upload' : 'download';
  const [source, target] = args.slice(args.indexOf(action)+1);
  if (action === 'upload') {
    const destination = path.join(tmp,'remote',target);
    if (fs.existsSync(destination)) fail();
    fs.mkdirSync(path.dirname(destination), {recursive:true});
    fs.cpSync(source, destination, {recursive:true});
    if (process.env.SCENARIO === 'changed-source') fs.appendFileSync(path.join(tmp,'source/notes/notes/one.md'),'changed');
  } else {
    if (fs.existsSync(target)) fail();
    fs.cpSync(path.join(tmp,'remote',source), target, {recursive:true});
    if (process.env.SCENARIO === 'corrupt') fs.appendFileSync(path.join(target,'notes/notes/one.md'),'corrupt');
    if (process.env.SCENARIO === 'extra-file') fs.writeFileSync(path.join(target,'.env'),'private-unexpected');
  }
  console.log('{}');
} else if (args[0] === 'variable' && args[1] === 'set') fs.writeFileSync(path.join(tmp,'activated'),args.find(a => a.startsWith('GRANITE_VAULT=')));
else fail();
`, { mode: 0o755 });
  env = { ...process.env, PATH: `${tmp}:${process.env.PATH}`, FAKE_ROOT: tmp, TYPESAFE_API_KEY: 'test-only-key' };
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

function run(...flags: string[]) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'src/index.ts', 'migrate', 'railway', '--vault', vault, '--project', 'project-id', '--service', 'service-id', '--environment', 'environment-id', ...flags], { cwd: root, env, encoding: 'utf8', timeout: 15000 });
}

it('defaults to read-only preflight and requires stopped writers for apply', () => {
  const dry = run();
  expect(dry.status, dry.stderr).toBe(0);
  expect(dry.stdout).toContain('Dry run');
  expect(fs.readdirSync(remote)).toEqual(['old-note.md']);
  const denied = run('--apply');
  expect(denied.status).not.toBe(0);
  expect(denied.stderr).toContain('--writers-stopped');
  expect(fs.existsSync(path.join(tmp, 'activated'))).toBe(false);
});

it('verifies exact transferred bytes before activating, preserving both previous copies and excluding machine secrets', () => {
  const result = run('--apply', '--writers-stopped');
  expect(result.status, result.stderr).toBe(0);
  const active = fs.readFileSync(path.join(tmp, 'activated'), 'utf8').replace('GRANITE_VAULT=/vault', '');
  const staged = path.join(remote, active);
  expect(fs.readFileSync(path.join(staged, 'notes/notes/one.md'), 'utf8')).toContain('stable-id');
  expect(fs.readFileSync(path.join(staged, 'assets/photo.png'))).toEqual(Buffer.from([0, 255, 12]));
  expect(fs.existsSync(path.join(staged, 'sync.json'))).toBe(false);
  expect(fs.existsSync(path.join(staged, 'notes/notes/.env'))).toBe(false);
  expect(fs.readFileSync(path.join(remote, 'old-note.md'), 'utf8')).toBe('preserved remote');
  expect(fs.readFileSync(path.join(vault, 'sync.json'), 'utf8')).toBe('private-local-token');
  expect(result.stdout).toContain('Activation submitted');
  expect(result.stdout).toContain('GRANITE_VAULT=/vault --json');
});

it.each(['corrupt', 'extra-file', 'changed-source', 'missing-key', 'old-runtime'])('does not activate when %s is detected', scenario => {
  env.SCENARIO = scenario;
  const result = run('--apply', '--writers-stopped');
  expect(result.status).not.toBe(0);
  expect(fs.existsSync(path.join(tmp, 'activated'))).toBe(false);
  expect(result.stderr + result.stdout).not.toContain('private-provider-secret');
  if (scenario === 'missing-key' || scenario === 'old-runtime') expect(fs.readdirSync(remote)).toEqual(['old-note.md']);
});

it.each(['symlink', 'traversal', 'missing-attachment'])('rejects unsafe or incomplete source content: %s', scenario => {
  if (scenario === 'symlink') fs.symlinkSync(path.join(tmp, 'remote'), path.join(vault, 'notes/notes/link'));
  if (scenario === 'traversal') {
    const config = fs.readFileSync(path.join(vault, 'granite.yml'), 'utf8').replace('notes/notes', '../remote');
    fs.writeFileSync(path.join(vault, 'granite.yml'), config);
  }
  if (scenario === 'missing-attachment') fs.writeFileSync(path.join(vault, 'notes/notes/one.md'), '---\ndocument_path: documents/file.pdf\n---\nDocument');
  const result = run('--apply', '--writers-stopped');
  expect(result.status).not.toBe(0);
  expect(fs.existsSync(path.join(tmp, 'calls'))).toBe(false);
  expect(fs.readdirSync(remote)).toEqual(['old-note.md']);
});

it('includes explicitly selected custom attachment directories', () => {
  fs.mkdirSync(path.join(vault, 'documents'));
  fs.writeFileSync(path.join(vault, 'documents/file.pdf'), 'document bytes');
  fs.writeFileSync(path.join(vault, 'notes/notes/one.md'), '---\ndocument_path: documents/file.pdf\n---\nDocument');
  const result = run('--apply', '--writers-stopped', '--include', 'documents');
  expect(result.status, result.stderr).toBe(0);
  const active = fs.readFileSync(path.join(tmp, 'activated'), 'utf8').replace('GRANITE_VAULT=/vault', '');
  expect(fs.readFileSync(path.join(remote, active, 'documents/file.pdf'), 'utf8')).toBe('document bytes');
});

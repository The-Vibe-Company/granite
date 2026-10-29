import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { migrationManifest, snapshotManifest, writeMigrationSnapshot } from '../core/railway-migration.js';

interface Options { vault: string; project: string; service: string; environment: string; apply?: boolean; writersStopped?: boolean; include?: string[] }

export function migrateRailwayCommand(options: Options): void {
  let temporary: string | undefined;
  try {
    if (options.apply && !options.writersStopped) throw new Error('--apply requires --writers-stopped after stopping all local and remote vault writers.');
    const target = ['--project', options.project, '--service', options.service, '--environment', options.environment];
    for (const id of [options.project, options.service, options.environment]) {
      if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error('Use explicit Railway project, service and environment IDs.');
    }
    const run = (args: string[], stage: string): string => {
      try { return execFileSync('railway', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000, maxBuffer: 1024 * 1024 }); }
      catch { throw new Error(`Railway ${stage} failed. Provider output suppressed because it may contain credentials.`); }
    };
    const manifest = migrationManifest(options.vault, options.include);
    let variables: Record<string, string>;
    try { variables = JSON.parse(run(['variable', 'list', ...target, '--json'], 'variable lookup')); }
    catch { throw new Error('Unable to read Railway variables. Authenticate the Railway CLI and verify the target IDs.'); }
    for (const name of ['GRANITE_MCP_TOKEN', 'TYPESAFE_API_KEY']) {
      // Railway redacts sealed values as null; the running entrypoint checks actual values.
      if (!(name in variables) || (variables[name] !== null && (typeof variables[name] !== 'string' || !variables[name].trim()))) throw new Error(`Destination is missing ${name}.`);
    }
    if (typeof variables.RAILWAY_VOLUME_MOUNT_PATH !== 'string' || !variables.RAILWAY_VOLUME_MOUNT_PATH) throw new Error('Destination is missing RAILWAY_VOLUME_MOUNT_PATH.');
    const mount = variables.RAILWAY_VOLUME_MOUNT_PATH;
    const previous = variables.GRANITE_VAULT || '/vault';
    for (const value of [mount, previous]) {
      if (!/^\/[a-zA-Z0-9_./-]+$/.test(value) || path.posix.normalize(value) !== value || value === '/') throw new Error('Destination must use canonical absolute volume and vault paths.');
    }
    if (previous !== mount && !previous.startsWith(`${mount}/`)) throw new Error('Destination vault is outside its volume.');
    let runtime: { capability: string; mount: string; vault: string; service: string; volume: string };
    let volumes: { volumes: { id: string; name: string; serviceName: string; mountPath: string; isPendingDeletion?: boolean; deletedAt?: string }[] };
    try {
      runtime = JSON.parse(run(['ssh', ...target, '--', 'docker-entrypoint.sh', '--granite-migration-capability'], 'runtime preflight'));
      volumes = JSON.parse(run(['volume', ...target, 'list', '--json'], 'volume lookup'));
    } catch { throw new Error('Cannot verify destination runtime and volume. Deploy the migration-capable Granite image and check Railway CLI access.'); }
    if (runtime.capability !== 'granite-railway-migration-v1' || runtime.mount !== mount || runtime.vault !== previous) throw new Error('Deploy the migration-capable Granite image and confirm its active vault matches Railway variables before retrying.');
    if (!runtime.service || !runtime.volume || !Array.isArray(volumes.volumes)) throw new Error('Destination runtime must identify its Railway service and volume.');
    const matches = volumes.volumes.filter(volume => volume.serviceName === runtime.service && volume.name === runtime.volume && volume.mountPath === mount && !volume.isPendingDeletion && !volume.deletedAt);
    if (matches.length !== 1 || !/^[a-zA-Z0-9_-]+$/.test(matches[0].id)) throw new Error('Cannot unambiguously identify the volume attached to this running service.');
    const volumeId = matches[0].id;
    const remote = `/.granite/migrations/${randomUUID()}`;
    const next = `${mount}${remote}`;
    console.log(`Target: project ${options.project}, service ${options.service}, environment ${options.environment}`);
    console.log(`Snapshot: ${Object.keys(manifest).length} files. Previous vault: ${previous}. New vault: ${next}`);
    const rollback = ['railway', 'variable', 'set', ...target, `GRANITE_VAULT=${previous}`, '--json'].join(' ');
    console.log(`Rollback (redeploys the preserved previous vault): ${rollback}`);
    if (!options.apply) {
      console.log('Dry run: no files uploaded or variables changed. Stop local and remote writers, back up both vaults, then repeat with --apply --writers-stopped.');
      return;
    }
    temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'granite-migration-'));
    const snapshot = path.join(temporary, 'snapshot');
    writeMigrationSnapshot(options.vault, snapshot, manifest);
    run(['volume', ...target, 'files', '--volume', volumeId, 'upload', snapshot, remote, '--json'], 'snapshot upload');
    const downloaded = path.join(temporary, 'verified');
    run(['volume', ...target, 'files', '--volume', volumeId, 'download', remote, downloaded, '--json'], 'snapshot download verification');
    if (JSON.stringify(snapshotManifest(downloaded)) !== JSON.stringify(manifest)) throw new Error('Uploaded snapshot failed hash verification. Destination remains unchanged.');
    if (JSON.stringify(migrationManifest(options.vault, options.include)) !== JSON.stringify(manifest)) throw new Error('Local vault changed during migration. Destination remains unchanged; stop writers and retry.');
    // Recheck deployed/configured source just before activation to avoid switching a changed target.
    let current: Record<string, string>;
    try { current = JSON.parse(run(['variable', 'list', ...target, '--json'], 'activation preflight')); }
    catch { throw new Error('Cannot verify destination configuration before activation. Provider output suppressed.'); }
    if ((current.GRANITE_VAULT || '/vault') !== previous || current.RAILWAY_VOLUME_MOUNT_PATH !== mount) throw new Error('Destination configuration changed during migration; activation cancelled.');
    run(['variable', 'set', ...target, `GRANITE_VAULT=${next}`, '--json'], 'activation (outcome may be uncertain; inspect GRANITE_VAULT before retrying)');
    console.log('Activation submitted; deployment and live MCP are not yet verified. Check /health, authenticated wakeup, representative notes and attachments, and persistence after restart before switching clients. Keep local writers stopped.');
  } catch (error) {
    console.error(`Migration failed: ${error instanceof Error ? error.message : 'unknown error'}`);
    process.exitCode = 1;
  } finally {
    if (temporary) fs.rmSync(temporary, { recursive: true, force: true });
  }
}

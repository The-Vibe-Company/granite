import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import matter from 'gray-matter';
import { loadConfig } from './config.js';
import { isIgnoredSyncPath } from './sync.js';

/** A portable snapshot deliberately excludes machine state and credentials. */
export function migrationManifest(root: string, include: string[] = []): Record<string, string> {
  if (fs.lstatSync(root).isSymbolicLink()) throw new Error('Source vault must not be a symbolic link.');
  root = fs.realpathSync(root);
  const files: Record<string, string> = {};
  const safe = (relative: string) => {
    const parts = relative.split('/');
    if (!relative || path.isAbsolute(relative) || relative.includes('\\') || parts.some(p => !p || p === '..' || p === '.')) {
      throw new Error('Migration paths must be relative paths inside the vault.');
    }
    return !parts.some(p => p.startsWith('.') || p === 'node_modules' || /^(?:credentials|secrets)(?:\.|$)/i.test(p)
      || /\.(?:pem|key|pid|log|db)(?:-|$)/i.test(p)) && !isIgnoredSyncPath(relative);
  };
  const visit = (relative: string) => {
    if (!safe(relative)) return;
    const absolute = path.join(root, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error('Migration refuses symbolic links in selected vault content.');
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(absolute).sort()) visit(`${relative}/${name}`);
    } else if (stat.isFile()) {
      files[relative] = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
    } else throw new Error('Migration supports regular files and directories only.');
  };
  visit('granite.yml');
  let config;
  try { config = loadConfig(root); } catch { throw new Error('Cannot read vault configuration; repair granite.yml before migrating.'); }
  const folders = [...Object.values(config.note_types).map(type => type.folder), 'assets', 'attachments', ...include];
  for (const folder of new Set(folders)) {
    if (!safe(folder)) throw new Error('Configured note folders must not contain excluded migration paths.');
    // Check every ancestor: lstat on the leaf alone cannot detect a symlink parent.
    let current = root;
    for (const component of folder.split('/')) {
      current = path.join(current, component);
      if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error('Migration refuses symbolic links in selected vault content.');
    }
    if (fs.existsSync(path.join(root, folder))) visit(folder);
    else if (include.includes(folder)) throw new Error('An explicitly included attachment directory does not exist.');
  }
  // Imported documents carry an explicit vault-relative attachment path. Refuse
  // an incomplete migration instead of silently dropping custom attachment roots.
  for (const relative of Object.keys(files).filter(file => file.endsWith('.md'))) {
    let data;
    try { data = matter(fs.readFileSync(path.join(root, relative), 'utf8')).data; }
    catch { throw new Error('Cannot parse note frontmatter; repair it before migrating.'); }
    if (typeof data.document_path === 'string' && !Object.hasOwn(files, data.document_path)) {
      throw new Error('A document_path attachment is missing from the snapshot. Restore the file or include its directory with --include.');
    }
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

export function writeMigrationSnapshot(root: string, destination: string, manifest: Record<string, string>): void {
  fs.mkdirSync(destination, { mode: 0o700 });
  for (const relative of Object.keys(manifest)) {
    const target = path.join(destination, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(root, relative), target, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(target, 0o600);
  }
  if (JSON.stringify(snapshotManifest(destination)) !== JSON.stringify(manifest)) {
    throw new Error('Source changed while preparing the migration snapshot. Stop all writers and retry.');
  }
}

/** Hash every transferred byte, including unexpected files; never follow links. */
export function snapshotManifest(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (directory: string) => {
    for (const name of fs.readdirSync(directory)) {
      const absolute = path.join(directory, name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) throw new Error('Snapshot contains a symbolic link.');
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile()) files[path.relative(root, absolute).split(path.sep).join('/')] = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
      else throw new Error('Snapshot contains a non-regular file.');
    }
  };
  visit(root);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

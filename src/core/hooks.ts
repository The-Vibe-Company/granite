import fs from 'node:fs';
import { normalizeAuthor } from './author.js';
import crypto from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type { GraniteConfig, Hook, Note, NoteFrontmatter, NoteTypeConfig } from './types.js';
import { resolveText } from './resolve.js';
import { slugify } from './slugify.js';

export interface HookContext {
  vaultRoot: string;
  config: GraniteConfig;
  db?: Database.Database;
  reservedSlugs?: Set<string>;
}

export interface HookResult {
  frontmatter: NoteFrontmatter;
  created_stubs: Array<{ slug: string; title: string; type: string }>;
}

/**
 * Apply on_create hooks declared on the note's type to its frontmatter.
 * Pure — returns the mutated frontmatter and any stubs that should be created.
 * The caller is responsible for actually writing the stub notes.
 */
export function applyOnCreateHooks(
  frontmatter: NoteFrontmatter,
  typeConfig: NoteTypeConfig,
  ctx: HookContext,
): HookResult {
  return runHooks(frontmatter, typeConfig.on_create ?? [], ctx);
}

function runHooks(
  frontmatter: NoteFrontmatter,
  hooks: Hook[],
  ctx: HookContext,
): HookResult {
  const out: NoteFrontmatter = { ...frontmatter };
  const created_stubs: HookResult['created_stubs'] = [];
  const reservedSlugs = new Set<string>(ctx.reservedSlugs ?? []);
  // Dedup resolutions in a single hook run so repeated refs reuse the first result.
  const resolvedByKey = new Map<string, string>();

  for (const hook of hooks) {
    switch (hook.action) {
      case 'resolve_wikilinks': {
        for (const fieldName of hook.fields) {
          const value = out[fieldName];
          if (value === undefined || value === null || value === '') continue;
          const typeConfig = findFieldTarget(ctx.config, out.type, fieldName);
          const targetType = typeConfig?.target_types?.[0];
          const resolveOne = (raw: string): string => {
            const key = `${targetType ?? '*'}::${raw.trim().toLowerCase()}`;
            const cached = resolvedByKey.get(key);
            if (cached !== undefined) return cached;
            const r = resolveOneField(raw, targetType, ctx, hook.auto_stub ?? false, reservedSlugs);
            if (r.stub) {
              created_stubs.push(r.stub);
              reservedSlugs.add(r.stub.slug);
            }
            resolvedByKey.set(key, r.value);
            return r.value;
          };
          if (Array.isArray(value)) {
            out[fieldName] = value.map(item => resolveOne(String(item)));
          } else {
            out[fieldName] = resolveOne(String(value));
          }
        }
        break;
      }
      case 'hash_source': {
        const sourcePath = out[hook.field];
        if (typeof sourcePath !== 'string' || !sourcePath) break;
        const absolute = path.isAbsolute(sourcePath) ? sourcePath : path.join(ctx.vaultRoot, sourcePath);
        if (!fs.existsSync(absolute)) break;
        const hash = crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex');
        out[hook.target] = hash;
        break;
      }
      case 'set_default': {
        if (out[hook.field] === undefined || out[hook.field] === null || out[hook.field] === '') {
          out[hook.field] = interpolateValue(hook.value);
        }
        break;
      }
    }
  }

  return { frontmatter: out, created_stubs };
}

function resolveOneField(
  raw: string,
  targetType: string | undefined,
  ctx: HookContext,
  autoStub: boolean,
  reservedSlugs: Set<string>,
): { value: string; stub?: { slug: string; title: string; type: string } } {
  const text = raw.trim();
  if (!text) return { value: raw };

  // Already a slug reference?
  if (/^[a-z0-9]+(-[a-z0-9]+)*$/.test(text)) {
    return { value: text };
  }

  if (!ctx.db) {
    return { value: slugify(text) || text };
  }

  const matches = resolveText(ctx.db, text, { target_type: targetType, limit: 1 });
  if (matches.length > 0) {
    return { value: matches[0].slug };
  }

  if (autoStub && targetType) {
    const baseSlug = slugify(text) || 'untitled';
    const stubSlug = allocateUniqueSlug(baseSlug, ctx, reservedSlugs);
    return {
      value: stubSlug,
      stub: { slug: stubSlug, title: text, type: targetType },
    };
  }

  return { value: slugify(text) || text };
}

function allocateUniqueSlug(
  base: string,
  ctx: HookContext,
  reservedSlugs: Set<string>,
): string {
  let slug = base;
  let counter = 2;
  while (slugTaken(slug, ctx, reservedSlugs)) {
    slug = `${base}-${counter}`;
    counter++;
  }
  return slug;
}

function slugTaken(slug: string, ctx: HookContext, reservedSlugs: Set<string>): boolean {
  if (reservedSlugs.has(slug)) return true;
  if (ctx.db) {
    const row = ctx.db.prepare('SELECT 1 AS present FROM notes WHERE slug = ? LIMIT 1').get(slug) as { present?: number } | undefined;
    if (row?.present) return true;
  }
  for (const typeConfig of Object.values(ctx.config.note_types)) {
    const candidate = path.join(ctx.vaultRoot, typeConfig.folder, `${slug}.md`);
    if (fs.existsSync(candidate)) return true;
  }
  return false;
}

function findFieldTarget(config: GraniteConfig, typeName: string, fieldName: string) {
  const typeConfig = config.note_types[typeName];
  if (!typeConfig) return undefined;
  return typeConfig.fields?.[fieldName];
}

function interpolateValue(template: string): string {
  return template
    .replace(/\$\{today\}/g, new Date().toISOString().slice(0, 10))
    .replace(/\$\{now\}/g, new Date().toISOString());
}

export function collectIndexedFieldValues(
  note: Note,
  typeConfig: NoteTypeConfig,
): Array<{ field: string; value: string }> {
  const out: Array<{ field: string; value: string }> = [];
  for (const field of new Set(['creator', 'last_modifier', ...(typeConfig.indexed_fields ?? [])])) {
    const value = field === 'creator' || field === 'last_modifier'
      ? normalizeAuthor(note.frontmatter[field]) : note.frontmatter[field];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      for (const v of value) {
        if (v !== undefined && v !== null && v !== '') {
          out.push({ field, value: String(v) });
        }
      }
    } else if (value !== '') {
      out.push({ field, value: String(value) });
    }
  }
  return out;
}

import type { GraniteConfig, NoteFrontmatter, NoteTypeConfig } from './types.js';

export interface ValidationIssue {
  code: string;
  field?: string;
  message: string;
}

export interface NoteValidationResult {
  passed: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
}

const RESERVED_FRONTMATTER_KEYS = new Set([
  'id', 'title', 'type', 'created', 'modified',
  'tags', 'aliases', 'status', 'source',
  'review_state', 'durability', 'derived_from',
]);

export function deriveBodySections(template: string): string[] {
  const matches = template.matchAll(/^##\s+(.+?)\s*$/gm);
  return Array.from(matches, m => m[1].trim()).filter(Boolean);
}

export function getRequiredSections(typeConfig: NoteTypeConfig): string[] {
  if (typeConfig.body_sections && typeConfig.body_sections.length > 0) {
    return typeConfig.body_sections;
  }
  return deriveBodySections(typeConfig.template ?? '');
}

export function bodyHasSection(body: string, section: string): boolean {
  const normalized = section.trim().toLowerCase();
  const lineRegex = /^##\s+(.+?)\s*$/gm;
  for (const m of body.matchAll(lineRegex)) {
    if ((m[1] ?? '').trim().toLowerCase() === normalized) return true;
  }
  return false;
}

export function validateNoteAgainstType(
  typeName: string,
  frontmatter: NoteFrontmatter | Record<string, unknown>,
  body: string,
  config: GraniteConfig,
): NoteValidationResult {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];

  const typeConfig = config.note_types[typeName];
  if (!typeConfig) {
    const valid = Object.keys(config.note_types).join(', ');
    errors.push({
      code: 'unknown_type',
      message: `Unknown note type "${typeName}". Valid types: ${valid}.`,
    });
    return { passed: false, errors, warnings };
  }

  for (const [fieldName, fieldDef] of Object.entries(typeConfig.fields ?? {})) {
    if (!fieldDef.required) continue;
    const value = (frontmatter as Record<string, unknown>)[fieldName];
    const missing = value === undefined
      || value === null
      || (typeof value === 'string' && value.trim() === '')
      || (Array.isArray(value) && value.length === 0);
    if (missing) {
      (typeConfig.warn_only ? warnings : errors).push({
        code: 'missing_required_field',
        field: fieldName,
        message: `Required frontmatter field "${fieldName}" is missing for type "${typeName}".`,
      });
    }
  }

  const requiredSections = getRequiredSections(typeConfig);
  const missingSections = requiredSections.filter(s => !bodyHasSection(body, s));
  if (missingSections.length > 0 && body.trim().length > 0) {
    warnings.push({
      code: 'missing_sections',
      message: `Body is missing expected ${missingSections.length === 1 ? 'section' : 'sections'} for type "${typeName}": ${missingSections.join(', ')}.`,
    });
  }

  if (typeConfig.line_limit && body.split('\n').length > typeConfig.line_limit) {
    (typeConfig.warn_only ? warnings : errors).push({
      code: 'line_limit_exceeded',
      message: `Body exceeds line_limit ${typeConfig.line_limit} for type "${typeName}".`,
    });
  }

  return { passed: errors.length === 0, errors, warnings };
}

/**
 * Stable short signature of the type registry — bumps when any type's
 * shape (fields, template, body_sections, indexed_fields, warn_only, line_limit) changes.
 */
export function computeTypeRegistrySignature(config: GraniteConfig): string {
  const parts: string[] = [];
  const sortedNames = Object.keys(config.note_types).sort();
  for (const name of sortedNames) {
    const t = config.note_types[name];
    const fields = Object.entries(t.fields ?? {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([fn, fd]) => `${fn}:${fd.type}${fd.required ? '!' : ''}`)
      .join(',');
    const sections = getRequiredSections(t).join('|');
    parts.push(`${name}[${fields};${sections};ix=${JSON.stringify(t.indexed_fields ?? [])};wo=${t.warn_only ? 1 : 0};ll=${t.line_limit ?? 0}]`);
  }
  return hashString(parts.join('\n')).slice(0, 8);
}

function hashString(input: string): string {
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = ((h << 5) + h + input.charCodeAt(i)) | 0;
  }
  // unsigned 32-bit hex
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function renderPreflightError(typeName: string, errors: ValidationIssue[]): string {
  const body = errors.map(e => `- ${e.code}${e.field ? ` (${e.field})` : ''}: ${e.message}`).join('\n');
  return `Cannot write note of type "${typeName}" — validation failed:\n${body}`;
}

export { RESERVED_FRONTMATTER_KEYS };

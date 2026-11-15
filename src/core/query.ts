import type Database from 'better-sqlite3';
import type { GraniteConfig } from './types.js';

export interface Query {
  creator?: string;
  last_modifier?: string;
  type?: string;
  where?: Record<string, QueryFilter>;
  sort?: { field: string; dir: 'asc' | 'desc' };
  limit?: number;
}

export type QueryFilter = string | { eq?: string; in?: string[]; gte?: string; lte?: string };

export interface QueryResult {
  slug: string;
  title: string;
  type: string;
  modified: string;
  fields: Record<string, string | string[]>;
}

/**
 * Deterministic structured query over note_fields + notes.
 * Only `indexed_fields` declared on the type are queryable.
 */
export function runQuery(
  db: Database.Database,
  config: GraniteConfig,
  query: Query,
): QueryResult[] {
  const type = query.type;
  const typeConfig = type ? config.note_types[type] : undefined;
  if (type && !typeConfig) {
    throw new Error(`Unknown note type: "${type}"`);
  }
  const indexed = typeConfig
    ? new Set(typeConfig.indexed_fields ?? [])
    : new Set(Object.values(config.note_types).flatMap(t => t.indexed_fields ?? []));
  const whereEntries = Object.entries({ ...query.where,
    ...(query.creator !== undefined ? { creator: query.creator } : {}),
    ...(query.last_modifier !== undefined ? { last_modifier: query.last_modifier } : {}),
  });
  for (const [field] of whereEntries) {
    if (field === 'status' || field === 'source' || field === 'creator' || field === 'last_modifier') continue;
    if (!indexed.has(field)) {
      throw new Error(
        `Field "${field}" is not indexed on type "${type ?? '<any>'}". Declare it in indexed_fields first.`,
      );
    }
  }

  const joins: string[] = [];
  const joinParams: unknown[] = [];
  const where: string[] = [];
  const whereParams: unknown[] = [];

  if (type) {
    where.push('n.type = ?');
    whereParams.push(type);
  }

  whereEntries.forEach(([field, filter], idx) => {
    if (field === 'status') {
      const { sql, p } = renderFilter('n.status', filter);
      where.push(sql);
      whereParams.push(...p);
      return;
    }
    if (field === 'source') {
      const { sql, p } = renderFilter('n.source', filter);
      where.push(sql);
      whereParams.push(...p);
      return;
    }
    if (field === 'creator' || field === 'last_modifier') {
      const alias = `a${idx}`;
      joins.push(`LEFT JOIN note_fields ${alias} ON ${alias}.slug = n.slug AND ${alias}.field_name = ?`);
      joinParams.push(field);
      const { sql, p } = renderFilter(`COALESCE(${alias}.field_value, 'unknown')`, filter);
      where.push(sql);
      whereParams.push(...p);
      return;
    }
    const alias = `f${idx}`;
    joins.push(`JOIN note_fields ${alias} ON ${alias}.slug = n.slug AND ${alias}.field_name = ?`);
    joinParams.push(field);
    const { sql, p } = renderFilter(`${alias}.field_value`, filter);
    where.push(sql);
    whereParams.push(...p);
  });

  let orderBy = 'n.modified DESC';
  if (query.sort) {
    if (query.sort.dir !== 'asc' && query.sort.dir !== 'desc') {
      throw new Error(`Invalid sort direction "${String(query.sort.dir)}". Use "asc" or "desc".`);
    }
    const dir = query.sort.dir === 'asc' ? 'ASC' : 'DESC';
    if (query.sort.field === 'modified' || query.sort.field === 'created' || query.sort.field === 'title') {
      orderBy = `n.${query.sort.field} ${dir}`;
    } else if (indexed.has(query.sort.field)) {
      const sortAlias = `fs_${whereEntries.length}`;
      joins.push(`LEFT JOIN note_fields ${sortAlias} ON ${sortAlias}.slug = n.slug AND ${sortAlias}.field_name = ?`);
      joinParams.push(query.sort.field);
      orderBy = `${sortAlias}.field_value ${dir}`;
    } else {
      throw new Error(`Cannot sort by non-indexed field "${query.sort.field}"`);
    }
  }

  const limit = Math.max(1, Math.min(query.limit ?? 25, 200));

  const sql = `
    SELECT DISTINCT n.slug, n.title, n.type, n.modified
    FROM notes n
    ${joins.join('\n')}
    ${where.length > 0 ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY ${orderBy}
    LIMIT ${limit}
  `;

  const params = [...joinParams, ...whereParams];
  const rows = db.prepare(sql).all(...params) as Array<{ slug: string; title: string; type: string; modified: string }>;

  const slugs = rows.map(r => r.slug);
  const fieldMap = new Map<string, Record<string, string | string[]>>();
  if (slugs.length > 0) {
    const placeholders = slugs.map(() => '?').join(',');
    const fieldRows = db.prepare(
      `SELECT slug, field_name, field_value FROM note_fields WHERE slug IN (${placeholders})`,
    ).all(...slugs) as Array<{ slug: string; field_name: string; field_value: string }>;
    for (const fr of fieldRows) {
      const entry = fieldMap.get(fr.slug) ?? {};
      const current = entry[fr.field_name];
      if (Array.isArray(current)) {
        current.push(fr.field_value);
      } else if (typeof current === 'string') {
        entry[fr.field_name] = [current, fr.field_value];
      } else {
        entry[fr.field_name] = fr.field_value;
      }
      fieldMap.set(fr.slug, entry);
    }
  }

  return rows.map(r => ({
    slug: r.slug,
    title: r.title,
    type: r.type,
    modified: r.modified,
    fields: { creator: 'unknown', last_modifier: 'unknown', ...fieldMap.get(r.slug) },
  }));
}

function renderFilter(column: string, filter: QueryFilter): { sql: string; p: unknown[] } {
  if (typeof filter === 'string') {
    return { sql: `${column} = ?`, p: [filter] };
  }
  if (filter.eq !== undefined) {
    return { sql: `${column} = ?`, p: [filter.eq] };
  }
  if (filter.in !== undefined) {
    if (filter.in.length === 0) {
      return { sql: '0', p: [] };
    }
    const placeholders = filter.in.map(() => '?').join(',');
    return { sql: `${column} IN (${placeholders})`, p: filter.in };
  }
  if (filter.gte !== undefined && filter.lte !== undefined) {
    return { sql: `${column} BETWEEN ? AND ?`, p: [filter.gte, filter.lte] };
  }
  if (filter.gte !== undefined) {
    return { sql: `${column} >= ?`, p: [filter.gte] };
  }
  if (filter.lte !== undefined) {
    return { sql: `${column} <= ?`, p: [filter.lte] };
  }
  return { sql: '1=1', p: [] };
}

export type NoteStatus = 'inbox' | 'active' | 'archived';
export type NoteSource = 'human' | 'agent' | 'extraction';
export type ReviewState = 'draft' | 'reviewed' | 'locked';
export type Durability = 'canonical' | 'working' | 'ephemeral';

export interface NoteFrontmatterDefaults {
  status?: NoteStatus;
  source?: NoteSource;
  review_state?: ReviewState;
  durability?: Durability;
  derived_from?: string[];
}

export interface NoteTypeConfig {
  folder: string;
  description: string;
  template: string;
  line_limit: number;
  warn_only: boolean;
  instructions?: string;
  slug_format?: 'title' | 'date';
  fields?: Record<string, FieldDefinition>;
  frontmatter_defaults?: NoteFrontmatterDefaults;
  body_sections?: string[];
  example_slug?: string;
  on_create?: Hook[];
  on_update?: Hook[];
  indexed_fields?: string[];
  views?: Record<string, ViewSpec>;
  lifecycle?: LifecycleSpec;
}

export interface FieldDefinition {
  type: 'text' | 'date' | 'number' | 'boolean' | 'wikilink' | 'list' | 'enum' | 'url';
  of?: string;
  options?: string[];
  required?: boolean;
  default?: string;
  description?: string;
  target_types?: string[];
  many?: boolean;
}

export type Hook =
  | { action: 'resolve_wikilinks'; fields: string[]; auto_stub?: boolean }
  | { action: 'hash_source'; field: string; target: string }
  | { action: 'set_default'; field: string; value: string };

export interface ViewSpec {
  description?: string;
  where?: Record<string, unknown>;
  sort?: { field: string; dir: 'asc' | 'desc' };
  limit?: number;
}

export interface LifecycleSpec {
  states: string[];
  transitions: LifecycleTransition[];
}

export interface LifecycleTransition {
  from: string;
  to: string;
  trigger: 'manual' | 'stale_days';
  days?: number;
}

export interface GraniteConfig {
  vault_name: string;
  version: number;
  note_types: Record<string, NoteTypeConfig>;
  defaults: {
    note_type: string;
    editor: string;
  };
  index: {
    auto_rebuild: boolean;
  };
}

export interface NoteFrontmatter {
  /** Original author, or unknown for legacy notes. Never changed by a revision. */
  creator?: string;
  /** Author of the last successful write. */
  last_modifier?: string;
  /** Most recent ten modifications, including creation until it ages out. */
  author_history?: Array<{ author: string; date: string }>;
  id: string;
  title: string;
  type: string;
  created: string;
  modified: string;
  tags: string[];
  aliases: string[];
  status: NoteStatus;
  source: NoteSource;
  review_state: ReviewState;
  durability: Durability;
  derived_from: string[];
  [key: string]: unknown;
}

export interface Note {
  slug: string;
  filepath: string;
  frontmatter: NoteFrontmatter;
  body: string;
  outgoing_links: WikiLink[];
}

export interface WikiLink {
  raw: string;
  target: string;
  display: string;
  resolved: boolean;
  resolved_slug?: string;
}

export interface SearchResult {
  slug: string;
  title: string;
  type: string;
  snippet: string;
  score: number;
}

export interface BacklinkEntry {
  source_slug: string;
  source_title: string;
  context: string;
}

export interface DoctorIssue {
  level: 'error' | 'warning' | 'info';
  file: string;
  message: string;
}

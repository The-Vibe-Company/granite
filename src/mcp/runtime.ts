import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { attachAsset, assetResourceUri, completeAssetFiles, readAssetResource, type AttachedAsset } from '../core/assets.js';
import { CONFIG_FILENAME, loadConfig } from '../core/config.js';
import { runDoctor } from '../core/doctor.js';
import { parseFrontmatter, serializeFrontmatter } from '../core/frontmatter.js';
import {
  GARDEN_ADJUDICATION_DEFAULT_BLOCKED_RECHECK_DAYS,
  readGardenAdjudicationStore,
  writeGardenAdjudicationStore,
  type GardenAdjudicationDecision,
  type GardenAdjudicationEntry,
  type GardenAdjudicationReasonCode,
} from '../core/garden-adjudications.js';
import { extractDocument as extractDocumentFromFile, type ExtractDocumentResult } from '../core/extract-document.js';
import {
  aboutEntity as readAboutEntity,
  entityPool as readEntityPool,
  filterAbout,
  renderAboutMarkdown,
  renderPoolMarkdown,
} from '../core/about.js';
import { buildFactLedger, currentStateOf, factsFromNotes, type Contradiction, type Fact } from '../core/facts.js';
import { findAlignmentCandidates, planAlignment, readEntityNotes, type AlignmentPlan } from '../core/entities.js';
import { importDocument as importDocumentToVault } from '../core/import-document.js';
import { resolveText, suggestStub, type ResolveMatch } from '../core/resolve.js';
import { runQuery, type Query, type QueryResult } from '../core/query.js';
import { compileContext, type CompileContextInput, type CompileContextResult } from '../core/compile-context.js';
import { openDatabase, rebuildIndex, syncNoteInIndex } from '../core/index-db.js';
import { findNoteBySlug, listNotes, createNote, readNote } from '../core/note.js';
import { getRecommendations } from '../core/recommendations.js';
import { searchNotes } from '../core/search.js';
import { suggestLinks } from '../core/suggest.js';
import {
  computeTypeRegistrySignature,
  getRequiredSections,
  renderPreflightError,
  RESERVED_FRONTMATTER_KEYS,
  validateNoteAgainstType,
  type NoteValidationResult,
} from '../core/validate.js';
import type {
  BacklinkEntry,
  DoctorIssue,
  Durability,
  GraniteConfig,
  Note,
  NoteFrontmatter,
  NoteSource,
  NoteStatus,
  ReviewState,
  SearchResult,
  WikiLink,
} from '../core/types.js';
import { parseWikilinks, resolveWikilinks } from '../core/wikilinks.js';
import { getBacklinks } from '../core/backlinks.js';
import {
  validateDurability,
  validateReviewState,
  validateSource,
  validateStatus,
} from '../core/json-output.js';

interface VaultSignature {
  noteCount: number;
  latestMutationMs: number;
  configMtimeMs: number;
}

export interface GraniteMcpRuntimeOptions {
  indexCheckIntervalMs?: number;
}

export interface NoteSummary {
  slug: string;
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
  filepath: string;
  resource_uri: string;
}

export interface NoteDetails extends NoteSummary {
  body: string;
  frontmatter: NoteFrontmatter;
  outgoing_links: WikiLink[];
}

export interface NoteTypeInfo {
  name: string;
  description: string;
  folder: string;
  line_limit: number;
  warn_only: boolean;
  slug_format: 'title' | 'date';
  instructions?: string;
  fields?: GraniteConfig['note_types'][string]['fields'];
  template?: string;
  body_sections?: string[];
  example_slug?: string;
  frontmatter_defaults?: Record<string, unknown>;
}

export interface VaultOverview {
  vault_root: string;
  vault_name: string;
  default_type: string;
  auto_rebuild: boolean;
  index_last_rebuild?: string;
  note_count: number;
  notes_by_type: Record<string, number>;
  recent_notes: NoteSummary[];
}

export interface NoteRecommendations {
  additions: Array<{ text: string }>;
  links: Array<{ slug: string; title: string; type: string; reason: string; source: 'mention' | 'search' }>;
  tags: Array<{ tag: string; weight: number; source_slugs: string[] }>;
  next_steps: Array<{ type: string; title_hint?: string; reason: string }>;
}

export interface NoteUnderstanding {
  note: NoteDetails;
  backlinks: BacklinkEntry[];
  link_suggestions: Array<{ target_slug: string; target_title: string; mentions: number }>;
  recommendations: NoteRecommendations;
  graph_role: {
    role: 'hub' | 'bridge' | 'reference' | 'isolated' | 'draft' | 'synthesis';
    reason: string;
    inbound_links: number;
    outbound_links: number;
    total_connections: number;
  };
}

export type GardenOpportunityKind =
  | 'hot-cluster-cold-hub'
  | 'stale-synthesis'
  | 'source-not-compiled'
  | 'draft-debt'
  | 'orphan-with-candidates'
  | 'thin-important-note'
  | 'duplicate-pair'
  | 'missing-synthesis-cluster';

export type GardenActionHint = 'revise' | 'connect' | 'merge' | 'synthesize' | 'review';
export type GardenAdjudicationDecisionInput = GardenAdjudicationDecision | 'clear';

export interface GardenPlanInput {
  anchor_slug?: string;
  limit?: number;
}

export interface GardenPlanNoteRef {
  slug: string;
  title: string;
  type: string;
  modified: string;
}

export interface GardenPlanScope {
  kind: 'vault' | 'anchor';
  anchor_slug?: string;
  generated_at: string;
  notes_considered: number;
  clusters_considered: number;
}

export interface GardenPlanOpportunity {
  id: string;
  kind: GardenOpportunityKind;
  priority: number;
  priority_raw: number;
  priority_effective: number;
  action_hint: GardenActionHint;
  targets: GardenPlanNoteRef[];
  supporting: GardenPlanNoteRef[];
  why_now: string;
  evidence: {
    signals: string[];
    metrics: Record<string, number>;
  };
  stop_when: string;
  adjudication?: GardenOpportunityAdjudication;
}

export interface GardenPlan {
  scope: GardenPlanScope;
  operator_hint: string;
  opportunities: GardenPlanOpportunity[];
}

export interface GardenOpportunityAdjudication {
  decision: GardenAdjudicationDecision;
  reason_code: GardenAdjudicationReasonCode;
  rationale?: string;
  recorded_at: string;
  active: boolean;
}

export interface AdjudicateGardenOpportunityInput {
  opportunity_id: string;
  decision: GardenAdjudicationDecisionInput;
  reason_code?: GardenAdjudicationReasonCode;
  rationale?: string;
  recheck_after_days?: number;
}

export interface GardenAdjudicationSummary extends GardenAdjudicationEntry {
  active: boolean;
}

export interface AdjudicateGardenOpportunityResult {
  opportunity_id: string;
  decision: GardenAdjudicationDecisionInput;
  adjudication: GardenAdjudicationSummary | null;
  cleared: boolean;
}

export interface CreateNoteInput {
  title: string;
  type?: string;
  body?: string;
  tags?: string[];
  aliases?: string[];
  status?: NoteStatus;
  source?: NoteSource;
  review_state?: ReviewState;
  durability?: Durability;
  derived_from?: string[];
  fields?: Record<string, unknown>;
}

export interface CaptureNoteInput {
  text: string;
  type?: string;
  tags?: string[];
  aliases?: string[];
  status?: NoteStatus;
  source?: NoteSource;
  review_state?: ReviewState;
  durability?: Durability;
  derived_from?: string[];
  fields?: Record<string, unknown>;
}

export interface UpdateNoteInput {
  type?: string;
  title?: string;
  body?: string;
  append?: string;
  tags?: string[];
  aliases?: string[];
  status?: NoteStatus;
  source?: NoteSource;
  review_state?: ReviewState;
  durability?: Durability;
  derived_from?: string[];
  fields?: Record<string, unknown>;
}

export interface ListNotesInput {
  type?: string;
  status?: NoteStatus;
  source?: NoteSource;
  since?: string;
  limit?: number;
}

export interface NoteMutationResult {
  note: NoteDetails;
  recommendations: NoteRecommendations;
  validation?: NoteValidationResult;
}

export interface ImportedDocumentAsset {
  file: string;
  path: string;
  relative_path: string;
  markdown: string;
  mime_type: string;
  sha256: string;
  resource_uri: string;
}

export interface ImportDocumentInput {
  file_path: string;
  content: string;
  title?: string;
  tags?: string[];
  aliases?: string[];
}

export interface ImportDocumentResult {
  note: NoteDetails;
  document: ImportedDocumentAsset;
  recommendations: NoteRecommendations;
}

export interface ExtractDocumentInput {
  file_path: string;
}

export interface DisposeNoteResult {
  slug: string;
  mode: 'archive' | 'delete';
  backlinks_removed: number;
  derived_children: number;
  note: NoteDetails | null;
}

interface GraphState {
  inbound: Map<string, Set<string>>;
  outbound: Map<string, Set<string>>;
  derivedChildren: Map<string, Set<string>>;
}

export class GraniteMcpRuntime {
  readonly vaultRoot: string;

  private config: GraniteConfig;
  private readonly db: Database.Database;
  private readonly indexCheckIntervalMs: number;
  private lastSignature?: VaultSignature;
  private lastIndexCheckAt = 0;

  constructor(vaultRoot: string, options: GraniteMcpRuntimeOptions = {}) {
    this.vaultRoot = path.resolve(vaultRoot);
    this.config = loadConfig(this.vaultRoot);
    this.db = openDatabase(this.vaultRoot);
    this.indexCheckIntervalMs = options.indexCheckIntervalMs ?? 1500;
  }

  getConfig(): GraniteConfig {
    return this.config;
  }

  close(): void {
    this.db.close();
  }

  getVaultOverview(recentLimit = 10): VaultOverview {
    const notes = this.readAllNotes()
      .sort((a, b) => b.frontmatter.modified.localeCompare(a.frontmatter.modified));
    const byType: Record<string, number> = {};

    for (const note of notes) {
      byType[note.frontmatter.type] = (byType[note.frontmatter.type] ?? 0) + 1;
    }

    return {
      vault_root: this.vaultRoot,
      vault_name: this.config.vault_name,
      default_type: this.config.defaults.note_type,
      auto_rebuild: this.config.index.auto_rebuild,
      index_last_rebuild: this.getMetaValue('last_rebuild'),
      note_count: notes.length,
      notes_by_type: byType,
      recent_notes: notes.slice(0, clampLimit(recentLimit, 20)).map(note => this.toNoteSummary(note)),
    };
  }

  listNoteTypes(): NoteTypeInfo[] {
    const recentByType = this.recentSlugByType();
    return Object.entries(this.config.note_types).map(([name, typeConfig]) => ({
      name,
      description: typeConfig.description,
      folder: typeConfig.folder,
      line_limit: typeConfig.line_limit,
      warn_only: typeConfig.warn_only,
      slug_format: typeConfig.slug_format ?? 'title',
      instructions: typeConfig.instructions,
      fields: typeConfig.fields,
      template: typeConfig.template,
      body_sections: getRequiredSections(typeConfig),
      example_slug: typeConfig.example_slug ?? recentByType.get(name),
      frontmatter_defaults: typeConfig.frontmatter_defaults as Record<string, unknown> | undefined,
    }));
  }

  listNoteTypeNames(): string[] {
    return Object.keys(this.config.note_types);
  }

  getTypeRegistrySignature(): string {
    return computeTypeRegistrySignature(this.config);
  }

  getDefaultNoteType(): string {
    return this.config.defaults.note_type;
  }

  private preflightValidate(
    typeName: string,
    extraFields: Record<string, unknown>,
    body: string | undefined,
  ): NoteValidationResult {
    const bodyForCheck = body ?? this.config.note_types[typeName]?.template ?? '';
    return validateNoteAgainstType(typeName, extraFields, bodyForCheck, this.config);
  }

  private recentSlugByType(): Map<string, string> {
    const latest = new Map<string, { slug: string; modified: string }>();
    for (const note of this.readAllNotes()) {
      if (note.frontmatter.status === 'archived') continue;
      const t = note.frontmatter.type;
      const existing = latest.get(t);
      if (!existing || note.frontmatter.modified > existing.modified) {
        latest.set(t, { slug: note.slug, modified: note.frontmatter.modified });
      }
    }
    const out = new Map<string, string>();
    for (const [t, v] of latest) out.set(t, v.slug);
    return out;
  }

  listNotes(input: ListNotesInput = {}): NoteSummary[] {
    let notes = this.readAllNotes();

    if (input.type) {
      notes = notes.filter(note => note.frontmatter.type === input.type);
    }

    if (input.status) {
      notes = notes.filter(note => note.frontmatter.status === input.status);
    }

    if (input.source) {
      notes = notes.filter(note => note.frontmatter.source === input.source);
    }

    if (input.since) {
      const since = input.since;
      notes = notes.filter(note => note.frontmatter.modified >= since);
    }

    notes.sort((a, b) => b.frontmatter.modified.localeCompare(a.frontmatter.modified));

    return notes
      .slice(0, clampLimit(input.limit ?? 25, 200))
      .map(note => this.toNoteSummary(note));
  }

  getNote(slug: string): NoteDetails {
    const note = this.requireNote(slug);
    const allNotes = this.readAllNotes();
    const outgoingLinks = resolveWikilinks(parseWikilinks(note.body), allNotes);

    return {
      ...this.toNoteSummary(note),
      body: note.body,
      frontmatter: note.frontmatter,
      outgoing_links: outgoingLinks,
    };
  }

  search(query: string, limit = 10): SearchResult[] {
    this.refreshIndex();
    return searchNotes(this.db, query, clampLimit(limit, 50));
  }

  resolve(text: string, options: { target_type?: string; limit?: number } = {}): {
    matches: ResolveMatch[];
    suggested_stub?: { type: string; title: string; slug: string };
  } {
    this.refreshIndex();
    const matches = resolveText(this.db, text, options);
    if (matches.length === 0 && options.target_type) {
      return { matches, suggested_stub: suggestStub(text, options.target_type) };
    }
    return { matches };
  }

  query(query: Query): { results: QueryResult[] } {
    this.refreshIndex();
    return { results: runQuery(this.db, this.config, query) };
  }

  compileContext(input: CompileContextInput): CompileContextResult {
    this.refreshIndex();
    return compileContext(this.db, this.config, input);
  }

  getBacklinks(slug: string): BacklinkEntry[] {
    this.requireNote(slug);
    this.refreshIndex();
    return getBacklinks(this.db, slug);
  }

  /**
   * Read an entity through the notes that reference it.
   *
   * This is the graph access path: it answers "what does the vault know about X" without
   * depending on the wording of the answer, which is what makes it language-independent.
   */
  readEntity(slug: string, options: { types?: string[] } = {}) {
    this.requireNote(slug);
    this.refreshIndex();
    const entity = readAboutEntity(this.db, slug);
    // `readAboutEntity` returns undefined only for a slug with no row, and `requireNote`
    // above has already rejected that, so reaching here with nothing would be a real bug.
    if (!entity) throw new Error(`Entity not found: ${slug}`);
    return filterAbout(entity, options.types);
  }

  /**
   * Emit the bounded, judge-ready candidate set around an anchor.
   *
   * Deliberately split from the judging: this decides *what is worth judging* and is free,
   * deterministic and testable. Ordering is by graph distance only — an earlier version
   * ordered by lexical overlap with the question and pushed the answering note out of the
   * pool, which is the exact failure this path exists to fix.
   */
  buildPool(anchor: string, options: { depth?: number; limit?: number; sentences?: number } = {}) {
    this.requireNote(anchor);
    this.refreshIndex();
    const pool = readEntityPool(this.db, anchor, options);
    if (!pool) throw new Error(`Note not found: ${anchor}`);
    return pool;
  }

  suggestLinks(slug: string) {
    const note = this.requireNote(slug);
    this.refreshIndex();
    return suggestLinks(this.db, note);
  }

  recommend(slug: string): NoteRecommendations {
    const note = this.requireNote(slug);
    this.refreshIndex();
    return getRecommendations(this.db, note, this.config);
  }

  understandNote(slug: string): NoteUnderstanding {
    const note = this.getNote(slug);
    const backlinks = this.getBacklinks(slug);
    const linkSuggestions = this.suggestLinks(slug);
    const recommendations = this.recommend(slug);
    const outboundLinks = note.outgoing_links.filter(link => link.resolved).length;
    const inboundLinks = backlinks.length;
    const totalConnections = inboundLinks + outboundLinks;

    let role: NoteUnderstanding['graph_role']['role'] = 'isolated';
    let reason = 'This note is currently disconnected from the graph.';

    if (note.frontmatter.status === 'inbox') {
      role = 'draft';
      reason = 'This note is still in the inbox and should be refined before it compounds.';
    } else if (note.frontmatter.type === 'synthesis') {
      role = 'synthesis';
      reason = 'This synthesis connects multiple notes and should remain highly linked.';
    } else if (inboundLinks >= 3 && outboundLinks >= 3) {
      role = 'hub';
      reason = 'This note has strong inbound and outbound links, so it acts as a hub.';
    } else if (inboundLinks > 0 && outboundLinks > 0) {
      role = 'bridge';
      reason = 'This note both references other notes and is referenced back, so it bridges context.';
    } else if (inboundLinks > 0) {
      role = 'reference';
      reason = 'Other notes point here, but this note is not yet linking back into the graph much.';
    }

    return {
      note,
      backlinks,
      link_suggestions: linkSuggestions,
      recommendations,
      graph_role: {
        role,
        reason,
        inbound_links: inboundLinks,
        outbound_links: outboundLinks,
        total_connections: totalConnections,
      },
    };
  }

  runDoctor(): { issues: DoctorIssue[]; counts: { errors: number; warnings: number; info: number } } {
    this.refreshIndex();
    const issues = runDoctor(this.vaultRoot, this.config, this.db);

    return {
      counts: {
        errors: issues.filter(issue => issue.level === 'error').length,
        warnings: issues.filter(issue => issue.level === 'warning').length,
        info: issues.filter(issue => issue.level === 'info').length,
      },
      issues,
    };
  }

  /**
   * Read the fact ledger: which facts are current, which were superseded, and which
   * contradict each other.
   *
   * The ledger is deterministic and lives here rather than in the tool handler, so an
   * agent can ask "what is current about X" without deciding it itself. Contradictions
   * are reported and never resolved, because automatic resolution was measured to
   * retire true facts far too often.
   */
  facts(input: { subject?: string; relation?: string } = {}): {
    total: number;
    current: Fact[];
    contradictions: Contradiction[];
    superseded: Array<{ fact: Fact; superseded_by?: string; reason: string }>;
    entries: Array<{ fact: Fact; status: string; superseded_by?: string; reason: string }>;
  } {
    this.refreshIndex();
    const ledger = buildFactLedger(factsFromNotes(this.readAllNotes()));
    const superseded = ledger.entries
      .filter(entry => entry.status === 'superseded')
      .map(entry => ({ fact: entry.fact, superseded_by: entry.superseded_by, reason: entry.reason }));

    if (input.subject) {
      const current = currentStateOf(ledger, input.subject, input.relation);
      return { total: ledger.entries.length, current, contradictions: ledger.contradictions, superseded, entries: ledger.entries };
    }
    return { total: ledger.entries.length, current: ledger.current, contradictions: ledger.contradictions, superseded, entries: ledger.entries };
  }

  /**
   * Find notes that may describe the same thing.
   *
   * Detection is deterministic (identical folded titles, or an alias claimed twice) and
   * the result separates what is safe to apply from what needs a decision. Nothing is
   * merged or rewritten here.
   */
  entities(input: { types?: string[] } = {}): {
    scanned: number;
    candidates: number;
    planned_aliases: AlignmentPlan['aliases'];
    review: AlignmentPlan['review'];
  } {
    this.refreshIndex();
    const notes = readEntityNotes(this.db, input.types);
    const candidates = findAlignmentCandidates(notes);
    const plan = planAlignment(candidates);
    return {
      scanned: notes.length,
      candidates: candidates.length,
      planned_aliases: plan.aliases,
      review: plan.review,
    };
  }

  wakeup(): {
    total: number;
    by_type: Record<string, number>;
    modified: string;
    clusters: Array<{ tag: string; slugs: string[]; hub: string | null }>;
    people: Array<{ slug: string; title: string }>;
    recent: Array<{ slug: string; age: string }>;
    stale: Array<{ slug: string; reason: string }>;
    aaak: string;
  } {
    this.refreshIndex();
    const notes = this.readAllNotes().filter(n => n.frontmatter.status !== 'archived');

    // Count connections
    const cx = new Map<string, number>();
    const linkRows = this.db.prepare(
      'SELECT source_slug, target_slug FROM links WHERE target_slug IS NOT NULL',
    ).all() as Array<{ source_slug: string; target_slug: string }>;
    for (const r of linkRows) {
      cx.set(r.source_slug, (cx.get(r.source_slug) ?? 0) + 1);
      cx.set(r.target_slug, (cx.get(r.target_slug) ?? 0) + 1);
    }

    // By type
    const byType: Record<string, number> = {};
    for (const n of notes) byType[n.frontmatter.type] = (byType[n.frontmatter.type] ?? 0) + 1;

    // Clusters by tag
    const tagNotes = new Map<string, Set<string>>();
    for (const n of notes) {
      for (const tag of n.frontmatter.tags ?? []) {
        if (!tagNotes.has(tag)) tagNotes.set(tag, new Set());
        tagNotes.get(tag)!.add(n.slug);
      }
    }
    const assigned = new Set<string>();
    const clusters: Array<{ tag: string; slugs: string[]; hub: string | null }> = [];
    const sortedTags = [...tagNotes.entries()]
      .filter(([, s]) => s.size >= 2)
      .sort((a, b) => b[1].size - a[1].size);
    for (const [tag, slugSet] of sortedTags) {
      const unassigned = [...slugSet].filter(s => !assigned.has(s));
      if (unassigned.length < 2) continue;
      let hub: string | null = null;
      let maxCx = 0;
      for (const s of unassigned) {
        const c = cx.get(s) ?? 0;
        if (c > maxCx) { maxCx = c; hub = s; }
      }
      clusters.push({ tag, slugs: unassigned, hub });
      for (const s of unassigned) assigned.add(s);
    }
    const misc = notes.filter(n => !assigned.has(n.slug)).map(n => n.slug);
    if (misc.length > 0) clusters.push({ tag: 'misc', slugs: misc, hub: null });

    // People
    const people = notes
      .filter(n => (n.frontmatter.tags ?? []).some(t => ['prospect', 'person', 'contact', 'founder', 'client'].includes(t)))
      .map(n => ({ slug: n.slug, title: n.frontmatter.title }));

    // Recent
    const sorted = [...notes].sort((a, b) => b.frontmatter.modified.localeCompare(a.frontmatter.modified));
    const getAge = (d: string): string => {
      const diff = Math.floor((Date.now() - new Date(d).getTime()) / 86400000);
      if (diff === 0) return 'today';
      if (diff === 1) return 'yesterday';
      if (diff < 7) return `${diff}d`;
      if (diff < 30) return `${Math.floor(diff / 7)}w`;
      return `${Math.floor(diff / 30)}mo`;
    };
    const recent = sorted.slice(0, 5).map(n => ({ slug: n.slug, age: getAge(n.frontmatter.modified) }));

    // Stale
    const twoWeeksAgo = new Date(Date.now() - 14 * 86400000).toISOString();
    const stale = notes
      .filter(n => n.frontmatter.durability === 'working' && n.frontmatter.modified < twoWeeksAgo && (cx.get(n.slug) ?? 0) < 2)
      .map(n => ({ slug: n.slug, reason: 'working+stale+disconnected' }));

    // AAAK
    const typeBreak = Object.entries(byType).map(([t, c]) => `${c}${t.slice(0, 3)}`).join(',');
    const lastMod = sorted[0]?.frontmatter.modified?.slice(0, 10) ?? '';
    const typeCount = Object.keys(this.config.note_types).length;
    const typeSig = this.getTypeRegistrySignature();
    const lines = [
      `VAULT: ${notes.length}n (${typeBreak}) | modified:${lastMod}`,
      `TYPES: ${typeCount} (sig=${typeSig}) -> granite://vault/types`,
      'CLUSTERS:',
    ];
    for (const cl of clusters) {
      const slugList = cl.slugs.map(s => {
        const c = cx.get(s) ?? 0;
        const n = notes.find(x => x.slug === s);
        const ann: string[] = [];
        if (s === cl.hub && c >= 5) ann.push('hub');
        if (n?.frontmatter.type === 'synthesis') ann.push('syn');
        if (n?.frontmatter.type === 'source') ann.push('src');
        if (n?.frontmatter.type === 'output') ann.push('out');
        if (c >= 5) ann.push(`${c}cx`);
        const short = s.length > 30 ? s.slice(0, 30) : s;
        return ann.length ? `${short}(${ann.join(',')})` : short;
      });
      lines.push(`  ${cl.tag.toUpperCase()}: ${slugList.join(' ')}`);
    }
    if (people.length) lines.push(`PEOPLE: ${people.map(p => p.title.slice(0, 20)).join(', ')}`);
    if (recent.length) lines.push(`RECENT: ${recent.slice(0, 5).map(r => `${r.slug.slice(0, 25)}(${r.age})`).join(' ')}`);
    const aaak = lines.join('\n');

    return { total: notes.length, by_type: byType, modified: sorted[0]?.frontmatter.modified ?? '', clusters, people, recent, stale, aaak };
  }

  planGarden(input: GardenPlanInput = {}): GardenPlan {
    this.refreshIndex();
    return this.buildGardenPlan(input);
  }

  adjudicateGardenOpportunity(input: AdjudicateGardenOpportunityInput): AdjudicateGardenOpportunityResult {
    if (input.decision === 'clear') {
      const store = readGardenAdjudicationStore(this.vaultRoot);
      const cleared = store.entries[input.opportunity_id] !== undefined;

      if (cleared) {
        delete store.entries[input.opportunity_id];
        writeGardenAdjudicationStore(this.vaultRoot, store);
      }

      return {
        opportunity_id: input.opportunity_id,
        decision: input.decision,
        adjudication: null,
        cleared,
      };
    }

    const plan = this.buildGardenPlan({}, { applyLimit: false, applyAdjudications: false });
    const opportunity = plan.opportunities.find(item => item.id === input.opportunity_id);
    if (!opportunity) {
      throw new Error(`Garden opportunity not found: ${input.opportunity_id}`);
    }

    const now = new Date().toISOString();
    const store = readGardenAdjudicationStore(this.vaultRoot);
    const existing = store.entries[input.opportunity_id];
    const reasonCode = input.reason_code ?? existing?.reason_code ?? 'low-value';
    const adjudication: GardenAdjudicationEntry = {
      opportunity_id: opportunity.id,
      kind: opportunity.kind,
      target_slugs: opportunity.targets.map(target => target.slug),
      decision: 'downrank',
      reason_code: reasonCode,
      rationale: input.rationale?.trim() || existing?.rationale,
      recorded_at: existing?.recorded_at ?? now,
      updated_at: now,
      recheck_after_days: resolveRecheckAfterDays(reasonCode, input.recheck_after_days),
      baseline: {
        target_modified_at: Object.fromEntries(opportunity.targets.map(target => [target.slug, target.modified])),
        supporting_modified_at: opportunity.supporting.length > 0
          ? Object.fromEntries(opportunity.supporting.map(target => [target.slug, target.modified]))
          : undefined,
      },
    };

    store.entries[opportunity.id] = adjudication;
    writeGardenAdjudicationStore(this.vaultRoot, store);

    return {
      opportunity_id: opportunity.id,
      decision: 'downrank',
      adjudication: this.toGardenAdjudicationSummary(adjudication),
      cleared: false,
    };
  }

  listGardenAdjudications(): GardenAdjudicationSummary[] {
    const notes = this.readAllNotes().filter(note => note.frontmatter.status !== 'archived');
    const noteBySlug = new Map(notes.map(note => [note.slug, note]));
    return this.getActiveGardenAdjudications(noteBySlug).map(entry => this.toGardenAdjudicationSummary(entry));
  }

  private buildGardenPlan(
    input: GardenPlanInput = {},
    options: { applyLimit?: boolean; applyAdjudications?: boolean } = {},
  ): GardenPlan {
    const generatedAt = new Date().toISOString();
    const notes = this.readAllNotes().filter(note => note.frontmatter.status !== 'archived');
    const noteBySlug = new Map(notes.map(note => [note.slug, note]));
    const wakeup = this.wakeup();
    const graph = this.buildGraphState(notes);

    if (input.anchor_slug) {
      this.requireNote(input.anchor_slug);
      if (!noteBySlug.has(input.anchor_slug)) {
        throw new Error(`Cannot plan around archived note: ${input.anchor_slug}`);
      }
    }

    const clusterBySlug = new Map<string, { tag: string; slugs: string[]; hub: string | null }>();
    for (const cluster of wakeup.clusters) {
      for (const slug of cluster.slugs) {
        if (!clusterBySlug.has(slug)) {
          clusterBySlug.set(slug, cluster);
        }
      }
    }

    const scopeSlugs = input.anchor_slug
      ? buildAnchorScopeSlugs(input.anchor_slug, graph, wakeup.clusters)
      : new Set(notes.map(note => note.slug));
    const scopeNotes = notes.filter(note => scopeSlugs.has(note.slug));
    const scopeClusters = input.anchor_slug
      ? wakeup.clusters.filter(cluster => cluster.slugs.includes(input.anchor_slug!))
      : wakeup.clusters.filter(cluster => cluster.slugs.some(slug => scopeSlugs.has(slug)));
    const limit = clampLimit(input.limit ?? 5, 20);

    const adjudicationById = options.applyAdjudications === false
      ? new Map<string, GardenAdjudicationEntry>()
      : new Map(
        this.getActiveGardenAdjudications(noteBySlug).map(entry => [entry.opportunity_id, entry] as const),
      );

    const opportunities = dedupeGardenOpportunities([
      ...this.buildDuplicatePairOpportunities(scopeNotes, graph),
      ...this.buildMissingSynthesisClusterOpportunities(scopeClusters, noteBySlug, graph),
      ...this.buildStaleSynthesisOpportunities(scopeNotes, noteBySlug, graph, clusterBySlug),
      ...this.buildHotClusterColdHubOpportunities(scopeClusters, noteBySlug, graph),
      ...this.buildSourceNotCompiledOpportunities(scopeNotes, notes, noteBySlug, graph),
      ...this.buildDraftDebtOpportunities(scopeNotes),
      ...this.buildOrphanWithCandidatesOpportunities(scopeNotes, noteBySlug, graph),
      ...this.buildThinImportantNoteOpportunities(scopeNotes, noteBySlug, graph),
    ].map(opportunity => applyGardenAdjudication(opportunity, adjudicationById.get(opportunity.id))));
    const limitedOpportunities = options.applyLimit === false ? opportunities : opportunities.slice(0, limit);

    return {
      scope: {
        kind: input.anchor_slug ? 'anchor' : 'vault',
        anchor_slug: input.anchor_slug,
        generated_at: generatedAt,
        notes_considered: scopeNotes.length,
        clusters_considered: scopeClusters.length,
      },
      operator_hint: buildGardenOperatorHint(limitedOpportunities, input.anchor_slug),
      opportunities: limitedOpportunities,
    };
  }

  attach(filePath: string, slug?: string): { file: string; path: string; markdown: string; slug: string | null } {
    const asset = attachAsset(this.vaultRoot, filePath);
    return { file: asset.file, path: asset.path, markdown: asset.markdown, slug: slug ?? null };
  }

  createNote(input: CreateNoteInput): NoteMutationResult {
    const resolvedType = input.type ?? this.config.defaults.note_type;
    const typeConfig = this.config.note_types[resolvedType];
    if (!typeConfig) {
      const valid = Object.keys(this.config.note_types).join(', ');
      throw new Error(`Unknown note type "${resolvedType}". Valid types in this vault: ${valid}.`);
    }

    if (!typeConfig.warn_only) {
      const preCheck = this.preflightValidate(resolvedType, input.fields ?? {}, input.body);
      if (preCheck.errors.length > 0) {
        throw new Error(renderPreflightError(resolvedType, preCheck.errors));
      }
    }

    const bodyOverride = input.body !== undefined
      ? ensureTrailingNewline(input.body)
      : typeConfig.slug_format === 'date'
        ? ensureTrailingNewline(input.title)
        : undefined;

    const created = createNote(this.vaultRoot, this.config, resolvedType, input.title, bodyOverride, {
      db: this.db,
      extraFrontmatter: input.fields,
    });
    const metadataMutations = {
      tags: input.tags,
      aliases: input.aliases,
      status: input.status,
      source: input.source,
      review_state: input.review_state,
      durability: input.durability,
      derived_from: input.derived_from,
    };

    if (hasMetadataMutations(metadataMutations)) {
      this.applyMutations(created.filepath, metadataMutations);
    }

    return this.afterWrite(created.slug, true);
  }

  captureNote(input: CaptureNoteInput): NoteMutationResult {
    const content = input.text.trim();
    if (!content) {
      throw new Error('Capture text cannot be empty.');
    }

    const firstLine = content.split('\n')[0] ?? 'Untitled';
    const title = firstLine.length > 60 ? `${firstLine.slice(0, 60).trim()}...` : firstLine;

    return this.createNote({
      title,
      type: input.type,
      body: ensureTrailingNewline(content),
      tags: input.tags,
      aliases: input.aliases,
      status: input.status,
      source: input.source,
      review_state: input.review_state,
      durability: input.durability,
      derived_from: input.derived_from,
      fields: input.fields,
    });
  }

  importDocument(input: ImportDocumentInput): ImportDocumentResult {
    const imported = importDocumentToVault(this.vaultRoot, this.config, input.file_path, {
      content: input.content,
      title: input.title,
      tags: input.tags,
      aliases: input.aliases,
    });

    const result = this.afterWrite(imported.note.slug, true);
    return {
      note: result.note,
      recommendations: result.recommendations,
      document: this.toImportedDocumentAsset(imported.asset),
    };
  }

  async extractDocument(input: ExtractDocumentInput): Promise<ExtractDocumentResult> {
    const resolvedPath = path.isAbsolute(input.file_path)
      ? input.file_path
      : path.join(this.vaultRoot, input.file_path);

    return extractDocumentFromFile(resolvedPath);
  }

  updateNote(slug: string, input: UpdateNoteInput): NoteMutationResult {
    if (input.type !== undefined) {
      return this.reviseNote(slug, input);
    }

    const note = this.requireNote(slug);
    const needsFullRebuild = input.title !== undefined || (input.aliases?.length ?? 0) > 0;

    this.applyMutations(note.filepath, input);

    if (needsFullRebuild) {
      return this.afterWrite(slug, true);
    }

    this.refreshIndex();
    const updated = readNote(note.filepath);
    syncNoteInIndex(this.vaultRoot, this.config, this.db, updated);
    this.captureSignature();

    return {
      note: this.getNote(updated.slug),
      recommendations: getRecommendations(this.db, updated, this.config),
    };
  }

  reviseNote(slug: string, input: UpdateNoteInput): NoteMutationResult {
    const note = this.requireNote(slug);
    const raw = fs.readFileSync(note.filepath, 'utf-8');
    const { frontmatter, body: existingBody } = parseFrontmatter(raw);
    let body = existingBody;
    let nextFilepath = note.filepath;
    let movedType = false;

    if (input.type !== undefined) {
      const nextType = this.config.note_types[input.type];
      if (!nextType) {
        const valid = Object.keys(this.config.note_types).join(', ');
        throw new Error(`Unknown note type "${input.type}". Valid types in this vault: ${valid}.`);
      }

      if (frontmatter.type !== input.type) {
        const targetFolder = path.join(this.vaultRoot, nextType.folder);
        fs.mkdirSync(targetFolder, { recursive: true });
        const candidatePath = path.join(targetFolder, `${slug}.md`);
        if (candidatePath !== note.filepath && fs.existsSync(candidatePath)) {
          throw new Error(`Cannot move "${slug}" to type "${input.type}" because ${candidatePath} already exists.`);
        }
        frontmatter.type = input.type;
        nextFilepath = candidatePath;
        movedType = true;
      }
    }

    if (input.title !== undefined) {
      frontmatter.title = input.title;
    }

    if (input.tags && input.tags.length > 0) {
      frontmatter.tags = mergeUnique(frontmatter.tags, input.tags);
    }

    if (input.aliases && input.aliases.length > 0) {
      frontmatter.aliases = mergeUnique(frontmatter.aliases, input.aliases);
    }

    if (input.status !== undefined) {
      validateStatus(input.status);
      frontmatter.status = input.status;
    }

    if (input.source !== undefined) {
      validateSource(input.source);
      frontmatter.source = input.source;
    }

    if (input.review_state !== undefined) {
      validateReviewState(input.review_state);
      frontmatter.review_state = input.review_state;
    }

    if (input.durability !== undefined) {
      validateDurability(input.durability);
      frontmatter.durability = input.durability;
    }

    if (input.derived_from !== undefined) {
      frontmatter.derived_from = [...input.derived_from];
    }

    if (input.fields) {
      for (const [key, value] of Object.entries(input.fields)) {
        if (RESERVED_FRONTMATTER_KEYS.has(key)) continue;
        (frontmatter as Record<string, unknown>)[key] = value;
      }
    }

    if (input.body !== undefined) {
      body = ensureTrailingNewline(input.body);
    }

    if (input.append !== undefined) {
      body = `${body.trimEnd()}\n${input.append}\n`;
    }

    const targetType = frontmatter.type;
    const typeConfig = this.config.note_types[targetType];
    if (typeConfig && !typeConfig.warn_only) {
      const pre = validateNoteAgainstType(targetType, frontmatter, body, this.config);
      if (pre.errors.length > 0) {
        throw new Error(renderPreflightError(targetType, pre.errors));
      }
    }

    frontmatter.modified = new Date().toISOString();
    fs.writeFileSync(nextFilepath, serializeFrontmatter(frontmatter, body), 'utf-8');

    if (movedType && nextFilepath !== note.filepath && fs.existsSync(note.filepath)) {
      fs.unlinkSync(note.filepath);
    }

    return this.afterWrite(slug, movedType || input.title !== undefined || (input.aliases?.length ?? 0) > 0);
  }

  disposeNote(slug: string, mode: 'archive' | 'delete' = 'archive'): DisposeNoteResult {
    const note = this.requireNote(slug);
    const backlinks = this.getBacklinks(slug);
    const derivedChildren = this.readAllNotes().filter(candidate =>
      candidate.frontmatter.derived_from.includes(slug),
    ).length;

    if (mode === 'archive') {
      const revised = this.reviseNote(slug, { status: 'archived' });
      return {
        slug,
        mode,
        backlinks_removed: backlinks.length,
        derived_children: derivedChildren,
        note: revised.note,
      };
    }

    fs.unlinkSync(note.filepath);
    this.refreshIndex(true);

    return {
      slug,
      mode,
      backlinks_removed: backlinks.length,
      derived_children: derivedChildren,
      note: null,
    };
  }

  readVaultConfigRaw(): string {
    return fs.readFileSync(path.join(this.vaultRoot, CONFIG_FILENAME), 'utf-8');
  }

  readVaultTypesJson(): string {
    return JSON.stringify({
      default_type: this.config.defaults.note_type,
      note_types: this.listNoteTypes(),
    }, null, 2);
  }

  readVaultOverviewJson(): string {
    return JSON.stringify(this.getVaultOverview(), null, 2);
  }

  readNoteMarkdown(slug: string): string {
    const note = this.requireNote(slug);
    return fs.readFileSync(note.filepath, 'utf-8');
  }

  readAsset(fileName: string):
    | { uri: string; mimeType: string; text: string }
    | { uri: string; mimeType: string; blob: string } {
    return readAssetResource(this.vaultRoot, fileName);
  }

  completeSlugs(prefix = ''): string[] {
    const normalizedPrefix = prefix.toLowerCase();

    return this.readAllNotes()
      .sort((a, b) => b.frontmatter.modified.localeCompare(a.frontmatter.modified))
      .map(note => note.slug)
      .filter(slug => slug.toLowerCase().startsWith(normalizedPrefix))
      .slice(0, 25);
  }

  completeAssets(prefix = ''): string[] {
    return completeAssetFiles(this.vaultRoot, prefix);
  }

  getTypeInstructions(typeName: string): string | undefined {
    return this.config.note_types[typeName]?.instructions;
  }

  noteResourceUri(slug: string): string {
    return `granite://notes/${encodeURIComponent(slug)}`;
  }

  assetResourceUri(fileName: string): string {
    return assetResourceUri(fileName);
  }

  private buildGraphState(notes: Note[]): GraphState {
    const noteBySlug = new Set(notes.map(note => note.slug));
    const inbound = new Map<string, Set<string>>();
    const outbound = new Map<string, Set<string>>();
    const derivedChildren = new Map<string, Set<string>>();
    const linkRows = this.db.prepare(
      'SELECT source_slug, target_slug FROM links WHERE target_slug IS NOT NULL',
    ).all() as Array<{ source_slug: string; target_slug: string }>;

    for (const row of linkRows) {
      if (!noteBySlug.has(row.source_slug) || !noteBySlug.has(row.target_slug)) {
        continue;
      }
      if (!outbound.has(row.source_slug)) outbound.set(row.source_slug, new Set());
      if (!inbound.has(row.target_slug)) inbound.set(row.target_slug, new Set());
      outbound.get(row.source_slug)?.add(row.target_slug);
      inbound.get(row.target_slug)?.add(row.source_slug);
    }

    for (const note of notes) {
      for (const parent of note.frontmatter.derived_from) {
        if (!noteBySlug.has(parent)) {
          continue;
        }
        if (!derivedChildren.has(parent)) derivedChildren.set(parent, new Set());
        derivedChildren.get(parent)?.add(note.slug);
      }
    }

    return { inbound, outbound, derivedChildren };
  }

  private buildStaleSynthesisOpportunities(
    scopeNotes: Note[],
    noteBySlug: Map<string, Note>,
    graph: GraphState,
    clusterBySlug: Map<string, { tag: string; slugs: string[]; hub: string | null }>,
  ): GardenPlanOpportunity[] {
    const opportunities: GardenPlanOpportunity[] = [];

    for (const note of scopeNotes) {
      if (note.frontmatter.type !== 'synthesis' || note.frontmatter.review_state === 'locked') {
        continue;
      }

      const cluster = clusterBySlug.get(note.slug);
      const related = new Map<string, Note>();
      for (const slug of note.frontmatter.derived_from) {
        const parent = noteBySlug.get(slug);
        if (parent) related.set(parent.slug, parent);
      }
      for (const slug of cluster?.slugs ?? []) {
        if (slug === note.slug) continue;
        const sibling = noteBySlug.get(slug);
        if (sibling) related.set(sibling.slug, sibling);
      }

      const newerRelated = [...related.values()]
        .filter(candidate => candidate.frontmatter.modified > note.frontmatter.modified)
        .sort((a, b) => b.frontmatter.modified.localeCompare(a.frontmatter.modified));
      if (newerRelated.length === 0) {
        continue;
      }

      const inboundLinks = getRelationCount(graph.inbound, note.slug);
      const outboundLinks = getRelationCount(graph.outbound, note.slug);
      const priority = 55
        + Math.min(18, newerRelated.length * 6)
        + Math.min(10, inboundLinks)
        + (daysSinceIso(note.frontmatter.modified) >= 21 ? 5 : 0)
        + (cluster ? 4 : 0);

      opportunities.push(createGardenOpportunity({
        kind: 'stale-synthesis',
        priority,
        action_hint: 'revise',
        targets: [note],
        supporting: newerRelated.slice(0, 3),
        why_now: 'This synthesis is older than related notes in the same knowledge area.',
        signals: [
          `${newerRelated.length} related note(s) are newer than the synthesis`,
          inboundLinks > 0 ? `the synthesis already has ${inboundLinks} backlink(s)` : 'the synthesis has low graph reinforcement',
          cluster ? `it belongs to the "${cluster.tag}" cluster` : 'it is supported by explicit derived_from links',
        ],
        metrics: {
          days_since_target_modified: daysSinceIso(note.frontmatter.modified),
          newer_related_notes: newerRelated.length,
          backlinks: inboundLinks,
          outgoing_links: outboundLinks,
        },
        stop_when: 'The synthesis reflects newer adjacent notes and its key links are up to date.',
      }));
    }

    return opportunities;
  }

  private buildHotClusterColdHubOpportunities(
    clusters: Array<{ tag: string; slugs: string[]; hub: string | null }>,
    noteBySlug: Map<string, Note>,
    graph: GraphState,
  ): GardenPlanOpportunity[] {
    const opportunities: GardenPlanOpportunity[] = [];

    for (const cluster of clusters) {
      if (!cluster.hub || cluster.slugs.length < 3) {
        continue;
      }

      const hub = noteBySlug.get(cluster.hub);
      if (!hub || hub.frontmatter.review_state === 'locked' || hub.frontmatter.type === 'synthesis') {
        continue;
      }

      const members = cluster.slugs
        .map(slug => noteBySlug.get(slug))
        .filter((note): note is Note => Boolean(note));
      const recentPeers = members.filter(note => note.slug !== hub.slug && daysSinceIso(note.frontmatter.modified) <= 14);
      const newerPeers = recentPeers.filter(note => note.frontmatter.modified > hub.frontmatter.modified);

      if (recentPeers.length < 2 || newerPeers.length < 2) {
        continue;
      }

      opportunities.push(createGardenOpportunity({
        kind: 'hot-cluster-cold-hub',
        priority: 58 + Math.min(16, recentPeers.length * 4) + Math.min(10, cluster.slugs.length),
        action_hint: 'revise',
        targets: [hub],
        supporting: newerPeers
          .sort((a, b) => b.frontmatter.modified.localeCompare(a.frontmatter.modified))
          .slice(0, 3),
        why_now: 'The surrounding cluster changed recently, but the hub note has not caught up.',
        signals: [
          `${recentPeers.length} peer note(s) changed in the last 14 days`,
          `${newerPeers.length} peer note(s) are newer than the hub`,
          `the hub anchors the "${cluster.tag}" cluster`,
        ],
        metrics: {
          cluster_size: cluster.slugs.length,
          recent_peers: recentPeers.length,
          newer_peers: newerPeers.length,
          days_since_target_modified: daysSinceIso(hub.frontmatter.modified),
          backlinks: getRelationCount(graph.inbound, hub.slug),
        },
        stop_when: 'The hub note reflects recent peer changes and reconnects the cluster coherently.',
      }));
    }

    return opportunities;
  }

  private buildSourceNotCompiledOpportunities(
    scopeNotes: Note[],
    allNotes: Note[],
    noteBySlug: Map<string, Note>,
    graph: GraphState,
  ): GardenPlanOpportunity[] {
    const opportunities: GardenPlanOpportunity[] = [];

    for (const note of scopeNotes) {
      if (note.frontmatter.type !== 'source' || note.frontmatter.review_state === 'locked') {
        continue;
      }

      const ageDays = daysSinceIso(note.frontmatter.modified);
      const backlinks = getRelationCount(graph.inbound, note.slug);
      const outgoing = getRelationCount(graph.outbound, note.slug);
      const children = getRelationCount(graph.derivedChildren, note.slug);
      const synthesisChildren = [...(graph.derivedChildren.get(note.slug) ?? new Set())]
        .map(slug => noteBySlug.get(slug))
        .filter((candidate): candidate is Note => Boolean(candidate))
        .filter(candidate => candidate.frontmatter.type === 'synthesis');

      if (ageDays < 7 || children > 0 || synthesisChildren.length > 0 || backlinks + outgoing > 2) {
        continue;
      }

      const related = allNotes
        .filter(candidate => candidate.slug !== note.slug && shareTags(note, candidate))
        .sort((a, b) => b.frontmatter.modified.localeCompare(a.frontmatter.modified))
        .slice(0, 3);

      opportunities.push(createGardenOpportunity({
        kind: 'source-not-compiled',
        priority: 50 + Math.min(15, Math.floor(ageDays / 7) * 3) + (hasImportedDocument(note) ? 5 : 0),
        action_hint: 'review',
        targets: [note],
        supporting: related,
        why_now: 'This source has been sitting in the vault without being distilled into durable knowledge.',
        signals: [
          `the source is ${ageDays} day(s) old`,
          children === 0 ? 'no note derives from it yet' : `${children} note(s) derive from it`,
          hasImportedDocument(note) ? 'an imported document is attached' : 'it has no imported document attachment',
        ],
        metrics: {
          days_since_target_modified: ageDays,
          backlinks,
          outgoing_links: outgoing,
          derived_children: children,
          synthesis_children: synthesisChildren.length,
        },
        stop_when: 'The source is summarized into durable notes or linked into a synthesis.',
      }));
    }

    return opportunities;
  }

  private buildDraftDebtOpportunities(scopeNotes: Note[]): GardenPlanOpportunity[] {
    const opportunities: GardenPlanOpportunity[] = [];

    for (const note of scopeNotes) {
      if (note.frontmatter.review_state !== 'draft' || note.frontmatter.status !== 'active') {
        continue;
      }

      const ageDays = daysSinceIso(note.frontmatter.modified);
      if (ageDays < 7) {
        continue;
      }

      opportunities.push(createGardenOpportunity({
        kind: 'draft-debt',
        priority: 45 + Math.min(18, Math.floor(ageDays / 7) * 4),
        action_hint: 'review',
        targets: [note],
        supporting: [],
        why_now: 'This draft has been left active for a while and should be promoted, merged, or archived.',
        signals: [
          `the draft has been untouched for ${ageDays} day(s)`,
          `its status is still ${note.frontmatter.status}`,
        ],
        metrics: {
          days_since_target_modified: ageDays,
          title_length: note.frontmatter.title.length,
        },
        stop_when: 'The draft is either promoted with confidence, merged into another note, or archived.',
      }));
    }

    return opportunities;
  }

  private buildOrphanWithCandidatesOpportunities(
    scopeNotes: Note[],
    noteBySlug: Map<string, Note>,
    graph: GraphState,
  ): GardenPlanOpportunity[] {
    const opportunities: GardenPlanOpportunity[] = [];

    for (const note of scopeNotes) {
      if (note.frontmatter.review_state === 'locked') {
        continue;
      }

      const backlinks = getRelationCount(graph.inbound, note.slug);
      const outgoing = getRelationCount(graph.outbound, note.slug);
      if (backlinks > 0 || outgoing > 1) {
        continue;
      }

      const suggestions = this.suggestLinks(note.slug).slice(0, 3)
        .map(suggestion => noteBySlug.get(suggestion.target_slug))
        .filter((candidate): candidate is Note => Boolean(candidate));
      if (suggestions.length === 0) {
        continue;
      }

      opportunities.push(createGardenOpportunity({
        kind: 'orphan-with-candidates',
        priority: 42 + Math.min(15, suggestions.length * 5) + Math.min(8, daysSinceIso(note.frontmatter.modified)),
        action_hint: 'connect',
        targets: [note],
        supporting: suggestions,
        why_now: 'This note is isolated, but Granite can already see plausible connection targets.',
        signals: [
          'the note has no backlinks',
          `${suggestions.length} candidate link target(s) were found`,
        ],
        metrics: {
          backlinks,
          outgoing_links: outgoing,
          candidate_links: suggestions.length,
          days_since_target_modified: daysSinceIso(note.frontmatter.modified),
        },
        stop_when: 'The note is connected to the graph through justified wikilinks.',
      }));
    }

    return opportunities;
  }

  private buildThinImportantNoteOpportunities(
    scopeNotes: Note[],
    noteBySlug: Map<string, Note>,
    graph: GraphState,
  ): GardenPlanOpportunity[] {
    const opportunities: GardenPlanOpportunity[] = [];

    for (const note of scopeNotes) {
      if (note.frontmatter.review_state === 'locked' || note.frontmatter.type !== 'note') {
        continue;
      }

      const backlinks = getRelationCount(graph.inbound, note.slug);
      const outgoing = getRelationCount(graph.outbound, note.slug);
      if (outgoing >= 2 || backlinks < 2) {
        continue;
      }

      const supporting = [...(graph.inbound.get(note.slug) ?? new Set())]
        .map(slug => noteBySlug.get(slug))
        .filter((candidate): candidate is Note => Boolean(candidate))
        .slice(0, 3);

      opportunities.push(createGardenOpportunity({
        kind: 'thin-important-note',
        priority: 38 + Math.min(18, backlinks * 4) - outgoing,
        action_hint: 'connect',
        targets: [note],
        supporting,
        why_now: 'Other notes already rely on this note, but it is still under-connected outward.',
        signals: [
          `${backlinks} note(s) already link here`,
          `the note only links out to ${outgoing} note(s)`,
        ],
        metrics: {
          backlinks,
          outgoing_links: outgoing,
          supporting_notes: supporting.length,
        },
        stop_when: 'The note links back into the graph with enough context to act as a bridge, not a dead end.',
      }));
    }

    return opportunities;
  }

  private buildDuplicatePairOpportunities(scopeNotes: Note[], graph: GraphState): GardenPlanOpportunity[] {
    const opportunities: GardenPlanOpportunity[] = [];

    for (let i = 0; i < scopeNotes.length; i += 1) {
      const left = scopeNotes[i];
      if (left.frontmatter.review_state === 'locked') {
        continue;
      }

      for (let j = i + 1; j < scopeNotes.length; j += 1) {
        const right = scopeNotes[j];
        if (right.frontmatter.review_state === 'locked') {
          continue;
        }

        const leftTitleTokens = gardenTitleTokens(left.frontmatter.title);
        const rightTitleTokens = gardenTitleTokens(right.frontmatter.title);
        const titleOverlap = jaccard(leftTitleTokens, rightTitleTokens);
        const sharedTags = sharedCount(left.frontmatter.tags, right.frontmatter.tags);
        const sharedNeighbors = sharedCount(
          getNeighborSlugs(left.slug, graph),
          getNeighborSlugs(right.slug, graph),
        );
        const normalizedLeft = normalizeGardenText(left.frontmatter.title);
        const normalizedRight = normalizeGardenText(right.frontmatter.title);
        const exactTitleMatch = normalizedLeft === normalizedRight;
        const contains = normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft);
        const shorterTokenCount = Math.min(leftTitleTokens.size, rightTitleTokens.size);
        const strongContainment = contains && shorterTokenCount >= 3;

        if (!exactTitleMatch && titleOverlap < 0.75 && !strongContainment) {
          continue;
        }
        if (!exactTitleMatch && titleOverlap < 0.75 && (sharedTags < 2 || sharedNeighbors < 2)) {
          continue;
        }
        if (sharedTags === 0 && sharedNeighbors === 0) {
          continue;
        }

        const priority = 68
          + Math.round(titleOverlap * 15)
          + Math.min(8, sharedTags * 3)
          + Math.min(6, sharedNeighbors * 2);
        opportunities.push(createGardenOpportunity({
          kind: 'duplicate-pair',
          priority,
          action_hint: 'merge',
          targets: [left, right],
          supporting: [],
          why_now: 'These notes appear to cover overlapping ground and may be splitting context.',
          signals: [
            `title overlap is ${Math.round(titleOverlap * 100)}%`,
            `${sharedTags} shared tag(s)`,
            `${sharedNeighbors} shared neighbor(s)`,
          ],
          metrics: {
            title_overlap_pct: Math.round(titleOverlap * 100),
            shared_tags: sharedTags,
            shared_neighbors: sharedNeighbors,
          },
          stop_when: 'The overlap is resolved by merging, clarifying scope, or archiving one side.',
        }));
      }
    }

    return opportunities;
  }

  private buildMissingSynthesisClusterOpportunities(
    clusters: Array<{ tag: string; slugs: string[]; hub: string | null }>,
    noteBySlug: Map<string, Note>,
    graph: GraphState,
  ): GardenPlanOpportunity[] {
    const opportunities: GardenPlanOpportunity[] = [];

    for (const cluster of clusters) {
      if (cluster.tag === 'misc') {
        continue;
      }

      if (cluster.slugs.length < 4) {
        continue;
      }

      const members = cluster.slugs
        .map(slug => noteBySlug.get(slug))
        .filter((note): note is Note => Boolean(note));
      if (members.some(note => note.frontmatter.type === 'synthesis')) {
        continue;
      }

      const recentMembers = members.filter(note => daysSinceIso(note.frontmatter.modified) <= 30);
      const ranked = [...members]
        .sort((a, b) => connectionCount(graph, b.slug) - connectionCount(graph, a.slug))
        .slice(0, 3);

      opportunities.push(createGardenOpportunity({
        kind: 'missing-synthesis-cluster',
        priority: 57 + Math.min(14, cluster.slugs.length * 2) + Math.min(9, recentMembers.length * 3),
        action_hint: 'synthesize',
        targets: ranked,
        supporting: members
          .filter(note => !ranked.some(target => target.slug === note.slug))
          .slice(0, 3),
        why_now: 'This cluster has enough connected material to justify a durable synthesis, but none exists yet.',
        signals: [
          `the cluster contains ${cluster.slugs.length} note(s)`,
          `${recentMembers.length} member(s) changed in the last 30 days`,
          `no synthesis note is present in the "${cluster.tag}" cluster`,
        ],
        metrics: {
          cluster_size: cluster.slugs.length,
          recent_members: recentMembers.length,
          ranked_targets: ranked.length,
        },
        stop_when: 'A synthesis exists with clear scope and links back to the cluster.',
      }));
    }

    return opportunities;
  }

  private refreshIndex(force = false): void {
    const now = Date.now();
    if (!force && now - this.lastIndexCheckAt < this.indexCheckIntervalMs) {
      return;
    }

    const currentConfigMtimeMs = this.getConfigMtimeMs();
    if (!this.lastSignature || currentConfigMtimeMs !== this.lastSignature.configMtimeMs) {
      this.config = loadConfig(this.vaultRoot);
    }

    const signature = this.computeSignature();
    let shouldRebuild = false;

    if (force) {
      shouldRebuild = true;
    } else if (this.config.index.auto_rebuild) {
      if (!this.lastSignature) {
        shouldRebuild =
          signature.noteCount !== this.getIndexedNoteCount() ||
          signature.latestMutationMs > this.getLastRebuildMs();
      } else {
        shouldRebuild =
          signature.noteCount !== this.lastSignature.noteCount ||
          signature.latestMutationMs !== this.lastSignature.latestMutationMs ||
          signature.configMtimeMs !== this.lastSignature.configMtimeMs;
      }
    }

    if (shouldRebuild) {
      rebuildIndex(this.vaultRoot, this.config, this.db);
    }

    this.lastSignature = signature;
    this.lastIndexCheckAt = now;
  }

  private readAllNotes(): Note[] {
    return listNotes(this.vaultRoot, this.config);
  }

  private requireNote(slug: string): Note {
    const note = findNoteBySlug(this.vaultRoot, this.config, slug);
    if (!note) {
      throw new Error(`Note not found: ${slug}`);
    }
    return note;
  }

  private toNoteSummary(note: Note): NoteSummary {
    return {
      slug: note.slug,
      title: note.frontmatter.title,
      type: note.frontmatter.type,
      created: note.frontmatter.created,
      modified: note.frontmatter.modified,
      tags: note.frontmatter.tags,
      aliases: note.frontmatter.aliases,
      status: note.frontmatter.status,
      source: note.frontmatter.source,
      review_state: note.frontmatter.review_state,
      durability: note.frontmatter.durability,
      derived_from: note.frontmatter.derived_from,
      filepath: note.filepath,
      resource_uri: this.noteResourceUri(note.slug),
    };
  }

  private toImportedDocumentAsset(asset: AttachedAsset): ImportedDocumentAsset {
    return {
      file: asset.file,
      path: asset.path,
      relative_path: asset.relative_path,
      markdown: asset.markdown,
      mime_type: asset.mime_type,
      sha256: asset.sha256,
      resource_uri: asset.resource_uri,
    };
  }

  private applyMutations(filepath: string, input: Omit<UpdateNoteInput, 'append'> & { append?: string }): void {
    const raw = fs.readFileSync(filepath, 'utf-8');
    const { frontmatter, body: existingBody } = parseFrontmatter(raw);
    let body = existingBody;

    if (input.title !== undefined) {
      frontmatter.title = input.title;
    }

    if (input.tags && input.tags.length > 0) {
      frontmatter.tags = mergeUnique(frontmatter.tags, input.tags);
    }

    if (input.aliases && input.aliases.length > 0) {
      frontmatter.aliases = mergeUnique(frontmatter.aliases, input.aliases);
    }

    if (input.status !== undefined) {
      validateStatus(input.status);
      frontmatter.status = input.status;
    }

    if (input.source !== undefined) {
      validateSource(input.source);
      frontmatter.source = input.source;
    }

    if (input.review_state !== undefined) {
      validateReviewState(input.review_state);
      frontmatter.review_state = input.review_state;
    }

    if (input.durability !== undefined) {
      validateDurability(input.durability);
      frontmatter.durability = input.durability;
    }

    if (input.derived_from !== undefined) {
      frontmatter.derived_from = [...input.derived_from];
    }

    if (input.body !== undefined) {
      body = ensureTrailingNewline(input.body);
    }

    if (input.append !== undefined) {
      body = `${body.trimEnd()}\n${input.append}\n`;
    }

    frontmatter.modified = new Date().toISOString();
    fs.writeFileSync(filepath, serializeFrontmatter(frontmatter, body), 'utf-8');
  }

  private afterWrite(slug: string, fullRebuild: boolean): NoteMutationResult {
    if (fullRebuild) {
      this.refreshIndex(true);
    } else {
      this.refreshIndex();
      const note = this.requireNote(slug);
      syncNoteInIndex(this.vaultRoot, this.config, this.db, note);
      this.captureSignature();
    }

    const note = this.requireNote(slug);
    const validation = validateNoteAgainstType(
      note.frontmatter.type,
      note.frontmatter,
      note.body,
      this.config,
    );

    return {
      note: this.getNote(note.slug),
      recommendations: getRecommendations(this.db, note, this.config),
      validation,
    };
  }

  private captureSignature(): void {
    this.lastSignature = this.computeSignature();
    this.lastIndexCheckAt = Date.now();
  }

  private computeSignature(): VaultSignature {
    let noteCount = 0;
    let latestNoteMtimeMs = 0;

    for (const typeConfig of Object.values(this.config.note_types)) {
      const folder = path.join(this.vaultRoot, typeConfig.folder);
      if (!fs.existsSync(folder)) {
        continue;
      }

      for (const entry of fs.readdirSync(folder)) {
        if (!entry.endsWith('.md')) {
          continue;
        }

        noteCount += 1;
        const stat = fs.statSync(path.join(folder, entry));
        latestNoteMtimeMs = Math.max(latestNoteMtimeMs, stat.mtimeMs);
      }
    }

    const configMtimeMs = this.getConfigMtimeMs();

    return {
      noteCount,
      latestMutationMs: Math.max(latestNoteMtimeMs, configMtimeMs),
      configMtimeMs,
    };
  }

  private getConfigMtimeMs(): number {
    const configPath = path.join(this.vaultRoot, CONFIG_FILENAME);
    return fs.existsSync(configPath) ? fs.statSync(configPath).mtimeMs : 0;
  }

  private getLastRebuildMs(): number {
    const value = this.getMetaValue('last_rebuild');
    return value ? Date.parse(value) || 0 : 0;
  }

  private getMetaValue(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  private getIndexedNoteCount(): number {
    const row = this.db.prepare('SELECT COUNT(*) as count FROM notes').get() as { count: number };
    return row.count;
  }

  private getActiveGardenAdjudications(noteBySlug: Map<string, Note>): GardenAdjudicationEntry[] {
    const store = readGardenAdjudicationStore(this.vaultRoot);
    const activeEntries: GardenAdjudicationEntry[] = [];
    let changed = false;

    for (const [opportunityId, entry] of Object.entries(store.entries)) {
      if (isGardenAdjudicationActive(entry, noteBySlug)) {
        activeEntries.push(entry);
        continue;
      }

      delete store.entries[opportunityId];
      changed = true;
    }

    if (changed) {
      writeGardenAdjudicationStore(this.vaultRoot, store);
    }

    activeEntries.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
    return activeEntries;
  }

  private toGardenAdjudicationSummary(entry: GardenAdjudicationEntry): GardenAdjudicationSummary {
    return {
      ...entry,
      active: true,
    };
  }
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function clampLimit(value: number, max: number): number {
  return Math.max(1, Math.min(value, max));
}

function mergeUnique(existing: string[], incoming: string[]): string[] {
  const merged = new Set(existing);
  for (const value of incoming) {
    const trimmed = value.trim();
    if (trimmed) {
      merged.add(trimmed);
    }
  }
  return [...merged];
}

function hasMetadataMutations(
  input: Pick<CreateNoteInput, 'tags' | 'aliases' | 'status' | 'source' | 'review_state' | 'durability' | 'derived_from'>,
): boolean {
  return (
    (input.tags?.length ?? 0) > 0 ||
    (input.aliases?.length ?? 0) > 0 ||
    input.status !== undefined ||
    input.source !== undefined ||
    input.review_state !== undefined ||
    input.durability !== undefined ||
    (input.derived_from?.length ?? 0) > 0
  );
}

function buildAnchorScopeSlugs(
  anchorSlug: string,
  graph: GraphState,
  clusters: Array<{ tag: string; slugs: string[]; hub: string | null }>,
): Set<string> {
  const scope = new Set<string>([anchorSlug]);

  for (const cluster of clusters) {
    if (cluster.slugs.includes(anchorSlug)) {
      for (const slug of cluster.slugs) {
        scope.add(slug);
      }
    }
  }

  for (const slug of graph.inbound.get(anchorSlug) ?? []) {
    scope.add(slug);
  }
  for (const slug of graph.outbound.get(anchorSlug) ?? []) {
    scope.add(slug);
  }
  for (const slug of graph.derivedChildren.get(anchorSlug) ?? []) {
    scope.add(slug);
  }
  for (const [parentSlug, children] of graph.derivedChildren.entries()) {
    if (children.has(anchorSlug)) {
      scope.add(parentSlug);
    }
  }

  return scope;
}

function createGardenOpportunity(input: {
  kind: GardenOpportunityKind;
  priority: number;
  action_hint: GardenActionHint;
  targets: Note[];
  supporting: Note[];
  why_now: string;
  signals: string[];
  metrics: Record<string, number>;
  stop_when: string;
}): GardenPlanOpportunity {
  const targets = input.targets.map(toGardenNoteRef);
  return {
    id: `${input.kind}:${targets.map(target => target.slug).sort().join('+')}`,
    kind: input.kind,
    priority: input.priority,
    priority_raw: input.priority,
    priority_effective: input.priority,
    action_hint: input.action_hint,
    targets,
    supporting: dedupeNoteRefs(input.supporting.map(toGardenNoteRef)).slice(0, 3),
    why_now: input.why_now,
    evidence: {
      signals: input.signals,
      metrics: input.metrics,
    },
    stop_when: input.stop_when,
  };
}

function buildGardenOperatorHint(opportunities: GardenPlanOpportunity[], anchorSlug?: string): string {
  if (opportunities.length === 0) {
    return anchorSlug
      ? `No high-leverage garden opportunities were found around "${anchorSlug}".`
      : 'No high-leverage garden opportunities were found in the vault.';
  }

  const top = opportunities[0];
  const targetTitles = top.targets.map(target => target.title).join(' + ');
  return `Start with ${targetTitles}: ${top.why_now}`;
}

function dedupeGardenOpportunities(opportunities: GardenPlanOpportunity[]): GardenPlanOpportunity[] {
  const sorted = [...opportunities].sort((a, b) =>
    b.priority_effective - a.priority_effective
    || b.priority_raw - a.priority_raw
    || a.id.localeCompare(b.id),
  );
  const claimed = new Set<string>();
  const seenIds = new Set<string>();
  const out: GardenPlanOpportunity[] = [];

  for (const opportunity of sorted) {
    if (seenIds.has(opportunity.id)) {
      continue;
    }

    const targetSlugs = opportunity.targets.map(target => target.slug);
    if (targetSlugs.every(slug => claimed.has(slug)) && !opportunity.adjudication) {
      continue;
    }

    out.push(opportunity);
    seenIds.add(opportunity.id);
    for (const slug of targetSlugs) {
      claimed.add(slug);
    }
  }

  return out;
}

function toGardenNoteRef(note: Note): GardenPlanNoteRef {
  return {
    slug: note.slug,
    title: note.frontmatter.title,
    type: note.frontmatter.type,
    modified: note.frontmatter.modified,
  };
}

function dedupeNoteRefs(refs: GardenPlanNoteRef[]): GardenPlanNoteRef[] {
  const seen = new Set<string>();
  const out: GardenPlanNoteRef[] = [];

  for (const ref of refs) {
    if (seen.has(ref.slug)) {
      continue;
    }
    seen.add(ref.slug);
    out.push(ref);
  }

  return out;
}

function applyGardenAdjudication(
  opportunity: GardenPlanOpportunity,
  adjudication?: GardenAdjudicationEntry,
): GardenPlanOpportunity {
  if (!adjudication) {
    return opportunity;
  }

  const priorityEffective = Math.min(opportunity.priority_raw, 15);
  return {
    ...opportunity,
    priority: priorityEffective,
    priority_effective: priorityEffective,
    adjudication: {
      decision: adjudication.decision,
      reason_code: adjudication.reason_code,
      rationale: adjudication.rationale,
      recorded_at: adjudication.recorded_at,
      active: true,
    },
  };
}

function isGardenAdjudicationActive(entry: GardenAdjudicationEntry, noteBySlug: Map<string, Note>): boolean {
  if (entry.target_slugs.some(slug => !noteBySlug.has(slug))) {
    return false;
  }

  switch (entry.reason_code) {
    case 'intentional-structure':
      return true;
    case 'blocked': {
      const recheckDays = entry.recheck_after_days ?? GARDEN_ADJUDICATION_DEFAULT_BLOCKED_RECHECK_DAYS;
      const recheckAt = Date.parse(entry.updated_at) + recheckDays * 86400000;
      return Number.isFinite(recheckAt) && recheckAt > Date.now();
    }
    case 'already-current':
      return !hasBaselineDrift(entry.baseline.target_modified_at, noteBySlug)
        && !hasBaselineDrift(entry.baseline.supporting_modified_at ?? {}, noteBySlug);
    case 'low-value':
      return !hasBaselineDrift(entry.baseline.target_modified_at, noteBySlug);
  }
}

function hasBaselineDrift(
  baseline: Record<string, string>,
  noteBySlug: Map<string, Note>,
): boolean {
  for (const [slug, modifiedAt] of Object.entries(baseline)) {
    const note = noteBySlug.get(slug);
    if (!note || note.frontmatter.modified > modifiedAt) {
      return true;
    }
  }
  return false;
}

function resolveRecheckAfterDays(
  reasonCode: GardenAdjudicationReasonCode,
  requested?: number,
): number | undefined {
  if (reasonCode !== 'blocked') {
    return undefined;
  }

  return requested ?? GARDEN_ADJUDICATION_DEFAULT_BLOCKED_RECHECK_DAYS;
}

function getRelationCount(map: Map<string, Set<string>>, slug: string): number {
  return map.get(slug)?.size ?? 0;
}

function connectionCount(graph: GraphState, slug: string): number {
  return getRelationCount(graph.inbound, slug) + getRelationCount(graph.outbound, slug);
}

function daysSinceIso(value: string): number {
  return Math.max(0, Math.floor((Date.now() - new Date(value).getTime()) / 86400000));
}

function hasImportedDocument(note: Note): boolean {
  return typeof note.frontmatter.document_file === 'string' && note.frontmatter.document_file.length > 0;
}

function shareTags(left: Note, right: Note): boolean {
  return sharedCount(left.frontmatter.tags, right.frontmatter.tags) > 0;
}

function sharedCount(left: Iterable<string>, right: Iterable<string>): number {
  const rightSet = new Set(Array.from(right, value => value.toLowerCase()));
  let count = 0;
  for (const value of left) {
    if (rightSet.has(value.toLowerCase())) {
      count += 1;
    }
  }
  return count;
}

function getNeighborSlugs(slug: string, graph: GraphState): Set<string> {
  const neighbors = new Set<string>();
  for (const value of graph.inbound.get(slug) ?? []) neighbors.add(value);
  for (const value of graph.outbound.get(slug) ?? []) neighbors.add(value);
  for (const value of graph.derivedChildren.get(slug) ?? []) neighbors.add(value);
  for (const [parentSlug, children] of graph.derivedChildren.entries()) {
    if (children.has(slug)) {
      neighbors.add(parentSlug);
    }
  }
  return neighbors;
}

function gardenTitleTokens(title: string): Set<string> {
  return new Set(
    normalizeGardenText(title)
      .split(/\s+/)
      .filter(token => token.length >= 3),
  );
}

function normalizeGardenText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 || right.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const value of left) {
    if (right.has(value)) {
      intersection += 1;
    }
  }
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

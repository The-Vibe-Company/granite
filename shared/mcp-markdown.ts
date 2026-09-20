interface NoteLike {
  slug: string;
  title: string;
  type: string;
  created?: string;
  modified?: string;
  tags?: string[];
  aliases?: string[];
  status?: string;
  source?: string;
  review_state?: string;
  durability?: string;
  derived_from?: string[];
  filepath?: string;
  resource_uri?: string;
}

interface WikiLinkLike {
  target: string;
  display: string;
  resolved: boolean;
  resolved_slug?: string;
}

interface NoteDetailsLike extends NoteLike {
  body: string;
  frontmatter?: Record<string, unknown>;
  outgoing_links?: WikiLinkLike[];
}

interface SearchResultLike {
  slug: string;
  title: string;
  snippet: string;
  score: number;
}

interface BacklinkLike {
  source_slug: string;
  source_title: string;
  context: string;
}

interface LinkSuggestionLike {
  target_slug: string;
  target_title: string;
  mentions: number;
}

interface RecommendationLike {
  additions: Array<{ text: string }>;
  links: Array<{ slug: string; title: string; type: string; reason: string; source: string }>;
  tags: Array<{ tag: string; weight: number; source_slugs: string[] }>;
  next_steps: Array<{ type: string; title_hint?: string; reason: string }>;
}

interface ValidationIssueLike {
  code: string;
  field?: string;
  message: string;
}

interface ValidationLike {
  passed: boolean;
  errors: ValidationIssueLike[];
  warnings: ValidationIssueLike[];
}

interface NoteTypeLike {
  name: string;
  description: string;
  folder: string;
  slug_format: string;
  instructions?: string;
  line_limit?: number;
  warn_only?: boolean;
  fields?: Record<string, {
    type: string;
    of?: string;
    options?: string[];
    required?: boolean;
    default?: string;
    description?: string;
  }>;
  template?: string;
  body_sections?: string[];
  example_slug?: string;
  frontmatter_defaults?: Record<string, unknown>;
}

interface VaultOverviewLike {
  vault_name: string;
  default_type: string;
  note_count: number;
  notes_by_type: Record<string, number>;
  recent_notes: NoteLike[];
  vault_root?: string;
  auto_rebuild?: boolean;
  index_last_rebuild?: string;
}

interface WakeupLike {
  total: number;
  by_type: Record<string, number>;
  modified: string;
  clusters: Array<{ tag: string; slugs: string[]; hub: string | null }>;
  people: Array<{ slug: string; title: string }>;
  recent: Array<{ slug: string; age: string }>;
  stale: Array<{ slug: string; reason: string }>;
  aaak?: string;
}

interface GardenPlanLike {
  scope: {
    kind: 'vault' | 'anchor';
    anchor_slug?: string;
    generated_at: string;
    notes_considered: number;
    clusters_considered: number;
  };
  operator_hint: string;
  opportunities: Array<{
    id: string;
    kind: string;
    priority_raw: number;
    priority_effective: number;
    action_hint: string;
    targets: Array<{ slug: string; title: string; type: string; modified: string }>;
    supporting: Array<{ slug: string; title: string; type: string; modified: string }>;
    why_now: string;
    stop_when: string;
    evidence: {
      signals: string[];
      metrics: Record<string, number>;
    };
    adjudication?: {
      reason_code: string;
      active: boolean;
    };
  }>;
}

interface AdjudicationLike {
  opportunity_id: string;
  kind: string;
  target_slugs: string[];
  decision: string;
  reason_code: string;
  rationale?: string;
  recorded_at: string;
  updated_at?: string;
  recheck_after_days?: number;
  active: boolean;
}

interface AdjudicationResultLike {
  opportunity_id: string;
  decision: string;
  adjudication: AdjudicationLike | null;
  cleared: boolean;
}

interface ImportedDocumentLike {
  note: NoteDetailsLike;
  document: {
    file: string;
    path: string;
    relative_path?: string;
    markdown?: string;
    mime_type: string;
    resource_uri: string;
  };
  recommendations: RecommendationLike;
}

interface ExtractedDocumentLike {
  doc_type: string;
  status: string;
  extractor: string;
  reading_basis?: string;
  raw_text: string;
  confidence?: number;
  limits?: string[];
  title_hint?: string;
  missing_dependency?: string;
  install_source_url?: string;
  verify_command?: string;
  user_prompt?: string;
}

interface DisposeNoteLike {
  slug: string;
  mode: string;
  backlinks_removed: number;
  derived_children: number;
  note: NoteDetailsLike | null;
}

interface NoteUnderstandingLike {
  note: NoteDetailsLike;
  backlinks: BacklinkLike[];
  link_suggestions: LinkSuggestionLike[];
  recommendations: RecommendationLike;
  graph_role: {
    role: string;
    reason: string;
    inbound_links: number;
    outbound_links: number;
    total_connections: number;
  };
}

export function renderVaultOverviewMarkdown(overview: VaultOverviewLike): string {
  const lines = ['# Vault Overview'];

  pushBullets(lines, [
    ['Vault', overview.vault_name],
    ['Default type', overview.default_type],
    ['Notes', String(overview.note_count)],
    ['Vault root', overview.vault_root],
    ['Auto rebuild', overview.auto_rebuild === undefined ? undefined : yesNo(overview.auto_rebuild)],
    ['Index rebuilt', overview.index_last_rebuild],
  ]);

  lines.push('', '## Notes by Type');
  if (Object.keys(overview.notes_by_type).length === 0) {
    lines.push('- None');
  } else {
    for (const [type, count] of Object.entries(overview.notes_by_type).sort((a, b) => b[1] - a[1])) {
      lines.push(`- \`${type}\`: ${count}`);
    }
  }

  lines.push('', '## Recent Notes');
  lines.push(...renderNoteTable(overview.recent_notes));

  return lines.join('\n');
}

export function renderNoteTypesMarkdown(noteTypes: NoteTypeLike[], defaultType?: string): string {
  const lines = ['# Note Types'];

  if (defaultType) {
    lines.push(`- Default type: \`${defaultType}\``);
  }
  lines.push(`- Types: ${noteTypes.length}`);
  lines.push('', '| Name | Folder | Slug | Description |', '| --- | --- | --- | --- |');
  for (const noteType of noteTypes) {
    lines.push(`| \`${escapeCell(noteType.name)}\` | \`${escapeCell(noteType.folder)}\` | \`${escapeCell(noteType.slug_format)}\` | ${escapeCell(noteType.description)} |`);
  }

  for (const noteType of noteTypes) {
    lines.push('', `## ${noteType.name}`);
    pushBullets(lines, [
      ['Folder', noteType.folder],
      ['Slug format', noteType.slug_format],
      ['Line limit', noteType.line_limit === undefined ? undefined : String(noteType.line_limit)],
      ['Warn only', noteType.warn_only === undefined ? undefined : yesNo(noteType.warn_only)],
      ['Instructions', noteType.instructions],
      ['Example', noteType.example_slug ? `\`${noteType.example_slug}\` (granite://notes/${noteType.example_slug})` : undefined],
    ]);

    if (noteType.body_sections && noteType.body_sections.length > 0) {
      lines.push('', `### Body sections`);
      lines.push(noteType.body_sections.map(s => `\`${escapeCell(s)}\``).join(' → '));
    }

    if (noteType.template && noteType.template.trim().length > 0) {
      lines.push('', '### Body template', '```markdown', noteType.template.replace(/\n+$/, ''), '```');
    }

    if (noteType.frontmatter_defaults && Object.keys(noteType.frontmatter_defaults).length > 0) {
      lines.push('', '### Frontmatter defaults');
      for (const [key, value] of Object.entries(noteType.frontmatter_defaults)) {
        lines.push(`- ${key}: ${formatUnknown(value)}`);
      }
    }

    if (noteType.fields && Object.keys(noteType.fields).length > 0) {
      lines.push('', '### Fields');
      lines.push('| Field | Type | Required | Description |', '| --- | --- | --- | --- |');
      for (const [name, field] of Object.entries(noteType.fields)) {
        const type = field.of ? `${field.type}<${field.of}>` : field.type;
        const descriptionParts = [field.description];
        if (field.options && field.options.length > 0) {
          descriptionParts.push(`options: ${field.options.join(', ')}`);
        }
        if (field.default !== undefined) {
          descriptionParts.push(`default: ${field.default}`);
        }
        lines.push(`| \`${escapeCell(name)}\` | \`${escapeCell(type)}\` | ${field.required ? 'yes' : 'no'} | ${escapeCell(descriptionParts.filter(Boolean).join('; '))} |`);
      }
    }
  }

  return lines.join('\n');
}

export function renderNotesMarkdown(notes: NoteLike[], title = 'Notes'): string {
  const lines = [`# ${title}`];
  lines.push(`- Count: ${notes.length}`, '', ...renderNoteTable(notes));
  return lines.join('\n');
}

export function renderSearchResultsMarkdown(query: string, results: SearchResultLike[]): string {
  const lines = ['# Search Results', `- Query: ${inlineCode(query)}`, `- Results: ${results.length}`, ''];
  if (results.length === 0) {
    lines.push('No matches.');
    return lines.join('\n');
  }

  lines.push('| Slug | Title | Score | Snippet |', '| --- | --- | --- | --- |');
  for (const result of results) {
    lines.push(`| \`${escapeCell(result.slug)}\` | ${escapeCell(result.title)} | ${result.score.toFixed(2)} | ${escapeCell(truncateInline(result.snippet, 160))} |`);
  }
  return lines.join('\n');
}

export function renderBacklinksMarkdown(slug: string, backlinks: BacklinkLike[]): string {
  const lines = ['# Backlinks', `- Target: \`${slug}\``, `- Backlinks: ${backlinks.length}`, ''];
  if (backlinks.length === 0) {
    lines.push('No backlinks.');
    return lines.join('\n');
  }

  lines.push('| Source | Title | Context |', '| --- | --- | --- |');
  for (const backlink of backlinks) {
    lines.push(`| \`${escapeCell(backlink.source_slug)}\` | ${escapeCell(backlink.source_title)} | ${escapeCell(truncateInline(backlink.context, 160))} |`);
  }
  return lines.join('\n');
}

export function renderLinkSuggestionsMarkdown(slug: string, suggestions: LinkSuggestionLike[]): string {
  const lines = ['# Link Suggestions', `- Note: \`${slug}\``, `- Suggestions: ${suggestions.length}`, ''];
  if (suggestions.length === 0) {
    lines.push('No link suggestions.');
    return lines.join('\n');
  }

  lines.push('| Target | Title | Mentions |', '| --- | --- | --- |');
  for (const suggestion of suggestions) {
    lines.push(`| \`${escapeCell(suggestion.target_slug)}\` | ${escapeCell(suggestion.target_title)} | ${suggestion.mentions} |`);
  }
  return lines.join('\n');
}

export function renderNoteDetailsMarkdown(note: NoteDetailsLike): string {
  const lines = [`# ${note.title}`];

  pushNoteMetadata(lines, note);

  const extraFrontmatter = note.frontmatter
    ? Object.entries(note.frontmatter).filter(([key]) => !STANDARD_FRONTMATTER_KEYS.has(key))
    : [];

  if (extraFrontmatter.length > 0) {
    lines.push('', '## Extra Frontmatter');
    for (const [key, value] of extraFrontmatter) {
      lines.push(`- ${key}: ${formatUnknown(value)}`);
    }
  }

  lines.push('', '## Body', note.body.trim() || '(empty)');

  lines.push('', '## Outgoing Links');
  if (!note.outgoing_links || note.outgoing_links.length === 0) {
    lines.push('- None');
  } else {
    lines.push('| Display | Target | Resolved |', '| --- | --- | --- |');
    for (const link of note.outgoing_links) {
      const resolvedTarget = link.resolved ? (link.resolved_slug ?? link.target) : link.target;
      lines.push(`| ${escapeCell(link.display)} | \`${escapeCell(resolvedTarget)}\` | ${link.resolved ? 'yes' : 'no'} |`);
    }
  }

  return lines.join('\n');
}

export function renderMutationResultMarkdown(
  action: string,
  note: NoteDetailsLike,
  recommendations: RecommendationLike,
  validation?: ValidationLike,
): string {
  const lines = [`# ${action} Note`];
  pushNoteMetadata(lines, note);

  const extraFrontmatter = note.frontmatter
    ? Object.entries(note.frontmatter).filter(([key]) => !STANDARD_FRONTMATTER_KEYS.has(key))
    : [];
  if (extraFrontmatter.length > 0) {
    lines.push('', '## Extra Frontmatter');
    for (const [key, value] of extraFrontmatter) {
      lines.push(`- ${key}: ${formatUnknown(value)}`);
    }
  }

  appendValidation(lines, validation);
  appendRecommendations(lines, recommendations);
  return lines.join('\n');
}

function appendValidation(lines: string[], validation?: ValidationLike): void {
  if (!validation) return;
  if (validation.passed && validation.warnings.length === 0) return;
  lines.push('', '## Type Validation');
  lines.push(`- Passed: ${yesNo(validation.passed)}`);
  if (validation.errors.length > 0) {
    lines.push('- Errors:');
    for (const e of validation.errors) {
      lines.push(`  - \`${e.code}\`${e.field ? ` (${e.field})` : ''}: ${e.message}`);
    }
  }
  if (validation.warnings.length > 0) {
    lines.push('- Warnings:');
    for (const w of validation.warnings) {
      lines.push(`  - \`${w.code}\`${w.field ? ` (${w.field})` : ''}: ${w.message}`);
    }
  }
}

export function renderUnderstandNoteMarkdown(result: NoteUnderstandingLike): string {
  const lines = ['# Note Context'];
  pushNoteMetadata(lines, result.note);
  lines.push('', '## Graph Role');
  pushBullets(lines, [
    ['Role', result.graph_role.role],
    ['Reason', result.graph_role.reason],
    ['Inbound links', String(result.graph_role.inbound_links)],
    ['Outbound links', String(result.graph_role.outbound_links)],
    ['Total connections', String(result.graph_role.total_connections)],
  ]);

  lines.push('', '## Backlinks');
  lines.push(...renderBacklinksSection(result.backlinks));

  lines.push('', '## Link Suggestions');
  lines.push(...renderLinkSuggestionsSection(result.link_suggestions));

  appendRecommendations(lines, result.recommendations);
  return lines.join('\n');
}

export function renderWakeupMarkdown(result: WakeupLike): string {
  const lines = ['# Vault Wakeup'];
  pushBullets(lines, [
    ['Notes', String(result.total)],
    ['Last modified', result.modified],
  ]);

  lines.push('', '## Notes by Type');
  for (const [type, count] of Object.entries(result.by_type).sort((a, b) => b[1] - a[1])) {
    lines.push(`- \`${type}\`: ${count}`);
  }

  lines.push('', '## Clusters');
  if (result.clusters.length === 0) {
    lines.push('- None');
  } else {
    for (const cluster of result.clusters) {
      const hub = cluster.hub ? `, hub: \`${cluster.hub}\`` : '';
      lines.push(`- \`${cluster.tag}\` (${cluster.slugs.length} notes${hub})`);
    }
  }

  lines.push('', '## Recent');
  if (result.recent.length === 0) {
    lines.push('- None');
  } else {
    for (const item of result.recent) {
      lines.push(`- \`${item.slug}\` (${item.age})`);
    }
  }

  lines.push('', '## Stale');
  if (result.stale.length === 0) {
    lines.push('- None');
  } else {
    for (const item of result.stale) {
      lines.push(`- \`${item.slug}\`: ${item.reason}`);
    }
  }

  if (result.people.length > 0) {
    lines.push('', '## People');
    for (const person of result.people) {
      lines.push(`- \`${person.slug}\`: ${person.title}`);
    }
  }

  if (result.aaak) {
    lines.push('', '## AAAK', result.aaak);
  }

  return lines.join('\n');
}

export function renderGardenPlanMarkdown(result: GardenPlanLike): string {
  const lines = ['# Garden Plan'];
  pushBullets(lines, [
    ['Scope', result.scope.kind === 'anchor' ? `anchor:${result.scope.anchor_slug}` : 'vault'],
    ['Generated at', result.scope.generated_at],
    ['Notes considered', String(result.scope.notes_considered)],
    ['Clusters considered', String(result.scope.clusters_considered)],
    ['Operator hint', result.operator_hint],
  ]);

  lines.push('', '## Opportunities');
  if (result.opportunities.length === 0) {
    lines.push('- None');
    return lines.join('\n');
  }

  for (const opportunity of result.opportunities) {
    const targetLabels = opportunity.targets.map(target => `\`${target.slug}\``).join(', ');
    lines.push(`### ${opportunity.kind} · ${targetLabels || '`none`'}`);
    pushBullets(lines, [
      ['Opportunity ID', opportunity.id],
      ['Action', opportunity.action_hint],
      ['Priority', `${opportunity.priority_effective.toFixed(2)} effective / ${opportunity.priority_raw.toFixed(2)} raw`],
      ['Why now', opportunity.why_now],
      ['Stop when', opportunity.stop_when],
      ['Adjudication', opportunity.adjudication ? `${opportunity.adjudication.reason_code} (${opportunity.adjudication.active ? 'active' : 'inactive'})` : undefined],
    ]);

    if (opportunity.supporting.length > 0) {
      lines.push('- Supporting: ' + opportunity.supporting.map(item => `\`${item.slug}\``).join(', '));
    }

    if (opportunity.evidence.signals.length > 0) {
      lines.push('- Signals: ' + opportunity.evidence.signals.join('; '));
    }

    const metrics = Object.entries(opportunity.evidence.metrics);
    if (metrics.length > 0) {
      lines.push('- Metrics: ' + metrics.map(([key, value]) => `${key}=${value}`).join(', '));
    }

    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function renderGardenAdjudicationsMarkdown(adjudications: AdjudicationLike[]): string {
  const lines = ['# Garden Adjudications', `- Active adjudications: ${adjudications.length}`, ''];
  if (adjudications.length === 0) {
    lines.push('No active adjudications.');
    return lines.join('\n');
  }

  for (const adjudication of adjudications) {
    lines.push(`## ${adjudication.kind} · \`${adjudication.opportunity_id}\``);
    pushBullets(lines, [
      ['Targets', adjudication.target_slugs.join(', ')],
      ['Decision', adjudication.decision],
      ['Reason', adjudication.reason_code],
      ['Recorded at', adjudication.recorded_at],
      ['Updated at', adjudication.updated_at],
      ['Recheck after days', adjudication.recheck_after_days === undefined ? undefined : String(adjudication.recheck_after_days)],
      ['Rationale', adjudication.rationale],
      ['Active', yesNo(adjudication.active)],
    ]);
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

export function renderAdjudicationResultMarkdown(result: AdjudicationResultLike): string {
  const lines = ['# Garden Adjudication'];
  pushBullets(lines, [
    ['Opportunity ID', result.opportunity_id],
    ['Decision', result.decision],
    ['Cleared', yesNo(result.cleared)],
  ]);

  if (result.adjudication) {
    lines.push('', '## Current State');
    pushBullets(lines, [
      ['Kind', result.adjudication.kind],
      ['Targets', result.adjudication.target_slugs.join(', ')],
      ['Reason', result.adjudication.reason_code],
      ['Recorded at', result.adjudication.recorded_at],
      ['Rationale', result.adjudication.rationale],
      ['Active', yesNo(result.adjudication.active)],
    ]);
  }

  return lines.join('\n');
}

interface QueryResultLike {
  slug: string;
  title: string;
  type: string;
  modified: string;
  fields: Record<string, string | string[]>;
}

export function renderQueryResultsMarkdown(results: QueryResultLike[]): string {
  const lines = [`# Query Results (${results.length})`, ''];
  if (results.length === 0) {
    lines.push('No matches.');
    return lines.join('\n');
  }

  const fieldNames = Array.from(
    new Set(results.flatMap(row => Object.keys(row.fields ?? {}))),
  );
  const header = ['title', 'slug', 'type', 'modified', ...fieldNames];
  lines.push(`| ${header.join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);

  for (const row of results) {
    const cells = [
      row.title,
      row.slug,
      row.type,
      row.modified,
      ...fieldNames.map(name => {
        const value = row.fields?.[name];
        if (value === undefined) return '';
        return Array.isArray(value) ? value.join(', ') : String(value);
      }),
    ];
    lines.push(`| ${cells.map(escapeCell).join(' | ')} |`);
  }

  return lines.join('\n');
}

export function renderImportDocumentMarkdown(result: ImportedDocumentLike): string {
  const lines = ['# Imported Document'];
  pushBullets(lines, [
    ['File', result.document.file],
    ['Type', result.document.mime_type],
    ['Stored at', result.document.path],
    ['Resource', result.document.resource_uri],
    ['Note', `${result.note.title} (\`${result.note.slug}\`)`],
  ]);
  appendRecommendations(lines, result.recommendations);
  return lines.join('\n');
}

export function renderExtractDocumentMarkdown(result: ExtractedDocumentLike): string {
  const lines = ['# Document Extraction'];
  pushBullets(lines, [
    ['Status', result.status],
    ['Document type', result.doc_type],
    ['Extractor', result.extractor],
    ['Reading basis', result.reading_basis],
    ['Confidence', result.confidence === undefined ? undefined : String(result.confidence)],
    ['Title hint', result.title_hint],
    ['Missing dependency', result.missing_dependency],
    ['Install source', result.install_source_url],
    ['Verify command', result.verify_command],
    ['User prompt', result.user_prompt],
  ]);

  if (result.limits && result.limits.length > 0) {
    lines.push('', '## Limits');
    for (const limit of result.limits) {
      lines.push(`- ${limit}`);
    }
  }

  lines.push('', '## Raw Text', result.raw_text.trim() || '(empty)');
  return lines.join('\n');
}

export function renderDisposeNoteMarkdown(result: DisposeNoteLike): string {
  const lines = ['# Disposed Note'];
  pushBullets(lines, [
    ['Slug', result.slug],
    ['Mode', result.mode],
    ['Backlinks removed', String(result.backlinks_removed)],
    ['Derived children', String(result.derived_children)],
    ['Archived note remains', result.note ? 'yes' : 'no'],
  ]);

  if (result.note) {
    lines.push('', '## Note');
    pushNoteMetadata(lines, result.note);
  }

  return lines.join('\n');
}

function pushNoteMetadata(lines: string[], note: NoteLike): void {
  pushBullets(lines, [
    ['Slug', note.slug],
    ['Type', note.type],
    ['Status', note.status],
    ['Source', note.source],
    ['Review state', note.review_state],
    ['Durability', note.durability],
    ['Created', note.created],
    ['Modified', note.modified],
    ['Tags', note.tags && note.tags.length > 0 ? note.tags.join(', ') : undefined],
    ['Aliases', note.aliases && note.aliases.length > 0 ? note.aliases.join(', ') : undefined],
    ['Derived from', note.derived_from && note.derived_from.length > 0 ? note.derived_from.join(', ') : undefined],
    ['Path', note.filepath],
    ['Resource', note.resource_uri],
  ]);
}

function appendRecommendations(lines: string[], recommendations: RecommendationLike): void {
  lines.push('', '## Recommendations');

  if (
    recommendations.additions.length === 0
    && recommendations.links.length === 0
    && recommendations.tags.length === 0
    && recommendations.next_steps.length === 0
  ) {
    lines.push('- None');
    return;
  }

  if (recommendations.additions.length > 0) {
    for (const addition of recommendations.additions) {
      lines.push(`- Addition: ${addition.text}`);
    }
  }

  if (recommendations.links.length > 0) {
    for (const link of recommendations.links) {
      lines.push(`- Link: \`${link.slug}\` (${link.type}, ${link.source}) — ${link.reason}`);
    }
  }

  if (recommendations.tags.length > 0) {
    for (const tag of recommendations.tags) {
      lines.push(`- Tag: \`${tag.tag}\` (${tag.weight.toFixed(2)}) from ${tag.source_slugs.join(', ')}`);
    }
  }

  if (recommendations.next_steps.length > 0) {
    for (const nextStep of recommendations.next_steps) {
      const titleHint = nextStep.title_hint ? ` title hint: ${nextStep.title_hint}.` : '';
      lines.push(`- Next step: \`${nextStep.type}\` — ${nextStep.reason}.${titleHint}`.replace('..', '.'));
    }
  }
}

function renderNoteTable(notes: NoteLike[]): string[] {
  if (notes.length === 0) {
    return ['No notes.'];
  }

  const lines = ['| Slug | Title | Type | Modified |', '| --- | --- | --- | --- |'];
  for (const note of notes) {
    lines.push(`| \`${escapeCell(note.slug)}\` | ${escapeCell(note.title)} | \`${escapeCell(note.type)}\` | ${escapeCell(note.modified ?? '')} |`);
  }
  return lines;
}

function renderBacklinksSection(backlinks: BacklinkLike[]): string[] {
  if (backlinks.length === 0) {
    return ['- None'];
  }

  const lines = ['| Source | Title | Context |', '| --- | --- | --- |'];
  for (const backlink of backlinks) {
    lines.push(`| \`${escapeCell(backlink.source_slug)}\` | ${escapeCell(backlink.source_title)} | ${escapeCell(truncateInline(backlink.context, 160))} |`);
  }
  return lines;
}

function renderLinkSuggestionsSection(suggestions: LinkSuggestionLike[]): string[] {
  if (suggestions.length === 0) {
    return ['- None'];
  }

  const lines = ['| Target | Title | Mentions |', '| --- | --- | --- |'];
  for (const suggestion of suggestions) {
    lines.push(`| \`${escapeCell(suggestion.target_slug)}\` | ${escapeCell(suggestion.target_title)} | ${suggestion.mentions} |`);
  }
  return lines;
}

function pushBullets(lines: string[], entries: Array<[string, string | undefined]>): void {
  for (const [label, value] of entries) {
    if (value) {
      lines.push(`- ${label}: ${value}`);
    }
  }
}

function truncateInline(value: string, max: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function formatUnknown(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (value === undefined) {
    return 'undefined';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map(item => formatUnknown(item)).join(', ');
  }
  return JSON.stringify(value);
}

function yesNo(value: boolean): string {
  return value ? 'yes' : 'no';
}

function inlineCode(value: string): string {
  return `\`${value.replace(/`/g, '\\`')}\``;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\n/g, '<br>');
}

const STANDARD_FRONTMATTER_KEYS = new Set([
  'id',
  'title',
  'type',
  'created',
  'modified',
  'tags',
  'aliases',
  'status',
  'source',
  'review_state',
  'durability',
  'derived_from',
]);

export interface FactLedgerLike {
  total: number;
  current: Array<{ subject: string; relation: string; object: string; valid_from: string; slug: string; source?: string }>;
  contradictions: Array<{
    subject: string;
    relation: string;
    facts: Array<{ object: string; valid_from: string; slug: string }>;
    detail: string;
  }>;
  superseded: Array<{
    fact: { subject: string; relation: string; object: string };
    superseded_by?: string;
    reason: string;
  }>;
}

/**
 * Render the fact ledger for an agent.
 *
 * Contradictions are shown as unresolved on purpose: the ledger reports them and never
 * picks a winner, because automatic resolution was measured to retire true facts far too
 * often. An agent reading this must decide, not assume the question is settled.
 */
export function renderFactsMarkdown(result: FactLedgerLike): string {
  const lines: string[] = ['# Fact Ledger', ''];
  lines.push(`- Facts recorded: ${result.total}`);
  lines.push(`- Current: ${result.current.length}`);
  lines.push(`- Contradictions: ${result.contradictions.length}`);
  lines.push('');

  if (result.total === 0) {
    lines.push('No facts yet. A fact is any note whose frontmatter declares');
    lines.push('`subject`, `relation`, `object` and `valid_from`. No new note type is required.');
    return lines.join('\n');
  }

  if (result.current.length > 0) {
    lines.push('## Current');
    for (const fact of result.current) {
      lines.push(`- **${fact.subject} · ${fact.relation}** = ${fact.object}  (since ${fact.valid_from})`);
    }
    lines.push('');
  }

  if (result.contradictions.length > 0) {
    lines.push('## Contradictions — NOT resolved');
    lines.push('');
    lines.push('These are open facts that disagree. The ledger does not choose between them;');
    lines.push('resolve by closing the interval on the one that stopped being true.');
    lines.push('');
    for (const contradiction of result.contradictions) {
      lines.push(`- **${contradiction.subject} · ${contradiction.relation}**`);
      for (const fact of contradiction.facts) {
        lines.push(`  - ${fact.object}  (from ${fact.valid_from}, \`${fact.slug}\`)`);
      }
    }
    lines.push('');
  }

  if (result.superseded.length > 0) {
    lines.push('## Superseded');
    for (const entry of result.superseded) {
      lines.push(`- ${entry.fact.subject} · ${entry.fact.relation} = ${entry.fact.object} → replaced by \`${entry.superseded_by}\``);
    }
  }
  return lines.join('\n');
}

export interface EntitiesLike {
  scanned: number;
  candidates: number;
  planned_aliases: Array<{ target: string; alias: string; from: string }>;
  review: Array<{
    candidate: {
      reason: string;
      matched_on: string;
      cross_type: boolean;
      a: { slug: string; title: string; type: string };
      b: { slug: string; title: string; type: string };
    };
    why: string;
  }>;
}

/**
 * Render entity-alignment candidates.
 *
 * Nothing here has been applied: the output separates what is safe to alias from what
 * needs a decision, and merging two notes is never automatic.
 */
export function renderEntitiesMarkdown(result: EntitiesLike): string {
  const lines: string[] = ['# Entity Alignment', ''];
  lines.push(`- Notes scanned: ${result.scanned}`);
  lines.push(`- Candidate pairs: ${result.candidates}`);
  lines.push('');

  if (result.candidates === 0) {
    lines.push('No two notes share an identical folded title or claim the same alias.');
    return lines.join('\n');
  }

  if (result.review.length > 0) {
    lines.push('## Needs a decision — not applied');
    for (const entry of result.review) {
      const c = entry.candidate;
      lines.push(`- \`${c.a.slug}\` (${c.a.type}) ↔ \`${c.b.slug}\` (${c.b.type})`);
      lines.push(`  - matched on "${c.matched_on}" (${c.reason})`);
      lines.push(`  - ${entry.why}`);
    }
    lines.push('');
  }

  if (result.planned_aliases.length > 0) {
    lines.push('## Safe to apply as aliases — reversible');
    for (const alias of result.planned_aliases) {
      lines.push(`- \`${alias.target}\` += "${alias.alias}"  (from \`${alias.from}\`)`);
    }
  }
  return lines.join('\n');
}

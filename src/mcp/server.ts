import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import type { MiddlewareHandler } from 'hono';
import net from 'node:net';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import * as z from 'zod/v4';
import {
  renderAdjudicationResultMarkdown,
  renderDisposeNoteMarkdown,
  renderExtractDocumentMarkdown,
  renderGardenAdjudicationsMarkdown,
  renderGardenPlanMarkdown,
  renderImportDocumentMarkdown,
  renderMutationResultMarkdown,
  renderNoteTypesMarkdown,
  renderQueryResultsMarkdown,
  renderSearchResultsMarkdown,
  renderEntitiesMarkdown,
  renderFactsMarkdown,
  renderUnderstandNoteMarkdown,
  renderWakeupMarkdown,
} from '../../shared/mcp-markdown.js';
import { GRANITE_VERSION } from '../version.js';
import { renderAboutMarkdown, renderPoolMarkdown } from '../core/about.js';
import {
  ABSENT_BELOW,
  ANSWERED_AT,
  apiKey as judgeApiKey,
  judgePool,
  model as judgeModel,
} from './judge.js';
import { isDocumentParsingDisabled } from '../core/extract-document.js';
import { registerReadOnlyApiRoutes } from '../web/api-routes.js';
import type { GraniteMcpRuntime } from './runtime.js';
import type { Query } from '../core/query.js';

const readOnlyAnnotations = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const writeAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const gardenAdjudicationReasonCodeSchema = z.enum([
  'intentional-structure',
  'already-current',
  'blocked',
  'low-value',
]);

export interface GraniteMcpHttpServerOptions {
  host: string;
  port: number;
  allowedOrigins?: string[];
  authToken?: string;
  jsonResponse?: boolean;
  role?: McpAccessRole;
  /** Also expose the read-only vault web API (/api/*, /assets/*) behind the same auth. */
  webApi?: boolean;
}

export type McpAccessRole = 'read' | 'write';

export interface GraniteMcpServerOptions {
  role?: McpAccessRole;
}

function buildServerInstructions(runtime: GraniteMcpRuntime, role: McpAccessRole): string {
  const types = runtime.listNoteTypes();
  const signature = runtime.getTypeRegistrySignature();
  const defaultType = runtime.getDefaultNoteType();
  const canWrite = role === 'write';
  const canParseDocuments = !isDocumentParsingDisabled();

  const lines: string[] = [
    '# Granite — Knowledge Compilation System',
    '',
    canWrite
      ? 'You are operating a local-first markdown knowledge base. You are the primary writer and gardener of this vault — the human rarely edits notes directly.'
      : 'You are operating a local-first markdown knowledge base in read-only mode. Inspect and compile context from the vault, but do not attempt to mutate it.',
    '',
    '## Public Interface',
    '',
    'Granite exposes a small public MCP surface:',
    '',
    '- **granite_wakeup** — load the map of the vault before doing work',
    '- **granite_facts** — read the fact ledger: what is current, superseded, or contradictory',
    '- **granite_entities** — find notes that may describe the same thing',
    '- **granite_research_topic** — discover relevant notes for a topic',
    '- **granite_resolve** — deterministically resolve free text to a note slug before linking',
    '- **granite_query** — run structured queries over typed notes and indexed fields',
    '- **granite_compile_context** — compile a typed brief for a topic or slug using the graph',
    '- **granite_plan_garden** — compute the highest-leverage notes or clusters to revisit next',
    '- **granite_list_garden_adjudications** — inspect the active operator adjudications influencing garden planning',
    ...(canParseDocuments ? [
      '- **granite_extract_document** — read a local document into raw extracted text without importing it',
    ] : []),
    '- **granite_understand_note** — inspect a note in context, not in isolation',
    '- **granite_about** — everything the vault knows about an entity, reached through its links rather than its wording',
    '- **granite_pool** — the bounded candidate set worth judging for a question, ordered by graph distance',
    ...(canWrite ? [
      '- **granite_adjudicate_garden_opportunity** — explicitly downrank or clear a garden opportunity the operator has adjudicated',
      '- **granite_capture_knowledge** — capture new knowledge into the vault',
      ...(canParseDocuments ? [
        '- **granite_import_document** — attach a file and create a linked source note with caller-provided content',
      ] : []),
      '- **granite_revise_note** — make targeted edits when workflow prompts are insufficient',
      '- **granite_dispose_note** — archive by default, delete only when intentional',
      '',
      'Use prompts for the higher-level workflows: refine notes, compile topics, and process the inbox.',
    ] : []),
    '',
    `## Note Types (vault registry, sig=${signature})`,
    '',
    `This vault declares ${types.length} type${types.length === 1 ? '' : 's'}. Default: \`${defaultType}\`. Full contracts (frontmatter fields, body sections, templates, canonical examples) are in the \`granite://vault/types\` resource — fetch it before writing if unsure.`,
    '',
  ];

  for (const t of types) {
    const requiredFields = Object.entries(t.fields ?? {})
      .filter(([, f]) => f.required)
      .map(([name]) => name);
    const sectionList = (t.body_sections ?? []).join(' / ');
    const headline = [
      `- **${t.name}** (\`${t.folder}\`, max ${t.line_limit} lines${t.warn_only ? ', advisory' : ', strict'})`,
      t.description ? `— ${t.description}` : '',
    ].filter(Boolean).join(' ');
    lines.push(headline);
    if (sectionList) lines.push(`  - Body sections: ${sectionList}`);
    if (requiredFields.length > 0) lines.push(`  - Required fields: ${requiredFields.join(', ')}`);
    if (t.example_slug) lines.push(`  - Example: \`${t.example_slug}\` (granite://notes/${t.example_slug})`);
  }

  lines.push(
    '',
    '## Working Principles',
    '',
    '- **Read in context.** Prefer granite_understand_note over piecing together note, backlinks, and suggestions manually.',
    '- **When you cannot guess the wording, go through the graph.** granite_about answers "what does the vault know about X" without depending on the language the notes are written in, and granite_pool emits the notes worth judging around an anchor. Measured on a real vault, keyword search found the answering note 2 times in 15 when the question and the note were in different languages, while graph access put it in the candidate set 14 times in 15 — but ordering by distance alone is no better than keyword search, so the pool still needs a judge to pick. Ordering is by graph distance only, never by lexical overlap.',
    ...(canWrite ? [
      '- **Capture first, refine second.** Capture quickly, then use workflow prompts to turn captures into durable knowledge.',
      '- **Link aggressively.** Use [[wikilinks]] in note bodies and follow recommendations after each revision.',
      '- **Archive before delete.** Knowledge systems should prefer reversible lifecycle transitions.',
    ] : []),
    canWrite
      ? '- **Respect the type registry.** Every note\'s type must exist in the vault config; write tools reject unknown types and report validation issues in their response.'
      : '- **Respect the type registry.** Every note\'s type is governed by the vault config exposed in granite://vault/types.',
    canParseDocuments
      ? '- **Prefer explicit extraction for documents.** Use granite://notes/{slug} for markdown, granite://vault/types for type contracts, and granite_extract_document before summarizing imported documents.'
      : '- **Document parsing is disabled in this deployment.** Extract and import documents from a local Granite instance; use granite://notes/{slug} for markdown and granite://vault/types for type contracts.',
  );

  return lines.join('\n');
}

export function createGraniteMcpServer(
  runtime: GraniteMcpRuntime,
  options: GraniteMcpServerOptions = {},
): McpServer {
  const role = options.role ?? 'write';
  const server = new McpServer(
    {
      name: 'granite',
      version: GRANITE_VERSION,
      title: 'Granite MCP Server',
    },
    {
      capabilities: { logging: {} },
      instructions: buildServerInstructions(runtime, role),
    },
  );

  registerTools(server, runtime, role);
  registerResources(server, runtime);
  if (role === 'write') {
    registerPrompts(server, runtime);
  }

  return server;
}

export async function startGraniteMcpStdioServer(
  runtime: GraniteMcpRuntime,
  options: GraniteMcpServerOptions = {},
): Promise<void> {
  const server = createGraniteMcpServer(runtime, options);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`Granite MCP server listening on stdio for ${runtime.vaultRoot}`);
}

export function startGraniteMcpHttpServer(runtime: GraniteMcpRuntime, options: GraniteMcpHttpServerOptions): void {
  if (requiresMcpHttpAuth(options.host) && !options.authToken?.trim()) {
    throw new Error('Refusing to bind Granite MCP HTTP server outside localhost without --auth-token or GRANITE_MCP_TOKEN.');
  }

  const app = createGraniteMcpHttpApp(runtime, options);

  console.error(`Granite MCP server listening on http://${options.host}:${options.port}/mcp`);
  console.error(`Health check: http://${options.host}:${options.port}/health`);
  console.error(`Vault: ${runtime.vaultRoot}`);

  serve({
    fetch: app.fetch,
    hostname: options.host,
    port: options.port,
  });
}

export async function withResponseCleanup(
  response: Response,
  cleanup: () => Promise<void> | void,
): Promise<Response> {
  let cleanedUp = false;

  const cleanupOnce = async () => {
    if (cleanedUp) {
      return;
    }
    cleanedUp = true;
    await cleanup();
  };

  if (!response.body) {
    await cleanupOnce();
    return response;
  }

  const reader = response.body.getReader();
  const wrappedBody = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          await cleanupOnce();
          return;
        }

        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
        await cleanupOnce();
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        await cleanupOnce();
      }
    },
  });

  return new Response(wrappedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

function buildTypeSchema(runtime: GraniteMcpRuntime, describe: string) {
  const names = runtime.listNoteTypeNames();
  if (names.length === 0) {
    return z.string().optional().describe(describe);
  }
  return z.enum(names as [string, ...string[]]).optional().describe(
    `${describe} Valid types in this vault: ${names.join(', ')}.`,
  );
}

function registerTools(server: McpServer, runtime: GraniteMcpRuntime, role: McpAccessRole): void {
  const canWrite = role === 'write';
  const canParseDocuments = !isDocumentParsingDisabled();

  server.registerTool('granite_facts', {
    title: 'Granite Facts',
    description: 'Read the fact ledger: which facts are current about a subject, which were superseded, and which contradict each other. Use before stating a fact about the user, a client or a project, so you answer from the current value instead of a stale note. Contradictions are reported and deliberately not resolved.',
    inputSchema: {
      subject: z.string().optional().describe('Return the current state of one subject only.'),
      relation: z.string().optional().describe('With subject, narrow to one relation.'),
    },
    annotations: readOnlyAnnotations,
  }, async ({ subject, relation }) => {
    const result = runtime.facts({ subject, relation });
    return toolResult(renderFactsMarkdown(result));
  });

  server.registerTool('granite_entities', {
    title: 'Granite Entities',
    description: 'Find notes that may describe the same thing, using deterministic signals (identical folded titles, or one alias claimed by two notes). Returns what is safe to apply as a reversible alias and what needs a human decision. Never merges or rewrites a note.',
    inputSchema: {
      types: z.array(z.string()).optional().describe('Restrict to these note types.'),
    },
    annotations: readOnlyAnnotations,
  }, async ({ types }) => {
    const result = runtime.entities({ types });
    return toolResult(renderEntitiesMarkdown(result));
  });

  server.registerTool('granite_wakeup', {
    title: 'Granite Wakeup',
    description: 'Load a compressed AAAK snapshot of the entire vault into context. Call this at the start of every session to know what exists, how notes cluster, and what changed recently. Costs ~200-500 tokens instead of reading every note.',
    annotations: readOnlyAnnotations,
  }, async () => {
    const result = runtime.wakeup();
    return toolResult(renderWakeupMarkdown(result));
  });

  server.registerTool('granite_research_topic', {
    title: 'Research Granite Topic',
    description: 'Discover the most relevant notes for a topic before writing or answering. Use this when you need to research the vault, avoid duplicates, or gather context for a synthesis.',
    inputSchema: {
      query: z.string().describe('Topic, keyword set, or research angle to search for in the vault.'),
      limit: z.number().int().min(1).max(50).optional().describe('Maximum number of results to return. Defaults to 10.'),
    },
    annotations: readOnlyAnnotations,
  }, async ({ query, limit }) => {
    const results = runtime.search(query, limit ?? 10);
    return toolResult(renderSearchResultsMarkdown(query, results));
  });

  server.registerTool('granite_plan_garden', {
    title: 'Plan Granite Garden',
    description: 'Compute a deterministic, prioritized garden work list. Use this to decide what in the whole vault, or around one anchor note, should be refreshed, connected, deduplicated, or synthesized next.',
    inputSchema: {
      anchor_slug: z.string().optional().describe('Optional note slug. When provided, the plan focuses on the anchor note, its local graph neighborhood, and its cluster.'),
      limit: z.number().int().min(1).max(20).optional().describe('Maximum number of opportunities to return. Defaults to 5.'),
    },
    annotations: readOnlyAnnotations,
  }, async ({ anchor_slug, limit }) => {
    const result = runtime.planGarden({ anchor_slug, limit });
    return toolResult(renderGardenPlanMarkdown(result));
  });

  if (canWrite) server.registerTool('granite_adjudicate_garden_opportunity', {
    title: 'Adjudicate Granite Garden Opportunity',
    description: 'Record an explicit operator adjudication for a specific garden opportunity. Use this when a deterministic signal is real but should be downranked locally, or when an old adjudication should be cleared.',
    inputSchema: {
      opportunity_id: z.string().describe('Exact garden opportunity ID from granite_plan_garden.'),
      decision: z.enum(['downrank', 'clear']).describe('Whether to downrank this opportunity or clear a prior adjudication.'),
      reason_code: gardenAdjudicationReasonCodeSchema.optional().describe('Required when decision is downrank. Explains why the local operator is overriding the heuristic.'),
      rationale: z.string().optional().describe('Optional operator rationale for auditability.'),
      recheck_after_days: z.number().int().min(1).max(365).optional().describe('Optional recheck window. Only allowed with reason_code "blocked"; defaults to 14 days.'),
    },
    annotations: writeAnnotations,
  }, async ({ opportunity_id, decision, reason_code, rationale, recheck_after_days }) => {
    if (decision === 'downrank' && !reason_code) {
      throw new Error('reason_code is required when decision is "downrank".');
    }
    if (decision === 'clear' && (reason_code !== undefined || rationale !== undefined || recheck_after_days !== undefined)) {
      throw new Error('clear does not accept reason_code, rationale, or recheck_after_days.');
    }
    if (recheck_after_days !== undefined && reason_code !== 'blocked') {
      throw new Error('recheck_after_days is only allowed when reason_code is "blocked".');
    }

    const result = runtime.adjudicateGardenOpportunity({
      opportunity_id,
      decision,
      reason_code,
      rationale,
      recheck_after_days,
    });
    return toolResult(renderAdjudicationResultMarkdown(result));
  });

  server.registerTool('granite_list_garden_adjudications', {
    title: 'List Granite Garden Adjudications',
    description: 'Inspect the active operator adjudications that are currently influencing Granite garden planning.',
    annotations: readOnlyAnnotations,
  }, async () => {
    const adjudications = runtime.listGardenAdjudications();
    return toolResult(renderGardenAdjudicationsMarkdown(adjudications));
  });

  if (canWrite) server.registerTool('granite_capture_knowledge', {
    title: 'Capture Granite Knowledge',
    description: 'Capture new knowledge into the vault. Use this for raw captures, semi-structured notes, or deliberately titled note drafts. Returns recommendations for what to connect or write next.',
    inputSchema: {
      text: z.string().optional().describe('Raw text to capture. Required unless title and body are both provided.'),
      title: z.string().optional().describe('Optional explicit title when creating a more deliberate draft.'),
      body: z.string().optional().describe('Optional explicit body when creating a more deliberate draft.'),
      type: buildTypeSchema(runtime, 'Optional note type. Defaults to the vault default type. Must be one of the vault-configured types (see granite://vault/types for each type\'s body sections and required fields).'),
      tags: z.array(z.string()).optional().describe('Tags to add immediately.'),
      aliases: z.array(z.string()).optional().describe('Aliases to add immediately.'),
      status: z.enum(['inbox', 'active', 'archived']).optional().describe('Initial note status.'),
      source: z.enum(['human', 'agent', 'extraction']).optional().describe('Initial note source.'),
      review_state: z.enum(['draft', 'reviewed', 'locked']).optional().describe('Initial review state.'),
      durability: z.enum(['canonical', 'working', 'ephemeral']).optional().describe('Initial durability.'),
      derived_from: z.array(z.string()).optional().describe('Source note IDs or slugs this note derives from.'),
      fields: z.record(z.string(), z.unknown()).optional().describe('Type-specific frontmatter fields (e.g. { date: "2026-04-17" } for meetings). Keys reserved by the system (id, title, type, created, modified, tags, aliases, status, source, review_state, durability, derived_from) are ignored here — use the dedicated inputs. See granite://vault/types for each type\'s required fields.'),
    },
    annotations: writeAnnotations,
  }, async (args) => {
    if (args.title) {
      const result = runtime.createNote({
        title: args.title,
        type: args.type,
        body: args.body ?? args.text,
        tags: args.tags,
        aliases: args.aliases,
        status: args.status,
        source: args.source,
        review_state: args.review_state,
        durability: args.durability,
        derived_from: args.derived_from,
        fields: args.fields,
      });
      return toolResult(renderMutationResultMarkdown('Created', result.note, result.recommendations, result.validation));
    }

    if (!args.text) {
      throw new Error('granite_capture_knowledge requires either text, or title with body/text.');
    }

    const result = runtime.captureNote({
      text: args.body ?? args.text,
      type: args.type,
      tags: args.tags,
      aliases: args.aliases,
      status: args.status,
      source: args.source,
      review_state: args.review_state,
      durability: args.durability,
      derived_from: args.derived_from,
      fields: args.fields,
    });
    return toolResult(renderMutationResultMarkdown('Captured', result.note, result.recommendations, result.validation));
  });

  if (canWrite && canParseDocuments) server.registerTool('granite_import_document', {
    title: 'Import Granite Document',
    description: 'Import a local document into the vault by attaching the file, creating a linked source note, and storing caller-provided document content in that note. This tool does not read, clean, or summarize the document for you.',
    inputSchema: {
      file_path: z.string().describe('Absolute or relative path to the local document file to import.'),
      content: z.string().min(1).describe('Caller-provided document text or cleaned extracted content to preserve in the source note body. Required.'),
      title: z.string().optional().describe('Optional explicit title for the source note. Defaults to a title derived from the filename.'),
      tags: z.array(z.string()).optional().describe('Tags to add immediately to the source note.'),
      aliases: z.array(z.string()).optional().describe('Aliases to add immediately to the source note.'),
    },
    annotations: writeAnnotations,
  }, async ({ file_path, content, title, tags, aliases }) => {
    const result = runtime.importDocument({ file_path, content, title, tags, aliases });
    const summary = renderImportDocumentMarkdown(result);

    return {
      content: [
        { type: 'text' as const, text: summary },
        createNoteResourceLink(result.note.title, result.note.resource_uri),
        createAssetResourceLink(result.document.file, result.document.resource_uri, result.document.mime_type),
      ],
    };
  });

  if (canParseDocuments) server.registerTool('granite_extract_document', {
    title: 'Extract Granite Document',
    description: 'Read a local document into raw extracted text without importing it. Use this before LLM cleaning and before granite_import_document when you need actual document understanding.',
    inputSchema: {
      file_path: z.string().describe('Absolute path, or vault-relative path, to the local document file to extract.'),
    },
    annotations: readOnlyAnnotations,
  }, async ({ file_path }) => {
    const result = await runtime.extractDocument({ file_path });
    return toolResult(renderExtractDocumentMarkdown(result));
  });

  server.registerTool('granite_understand_note', {
    title: 'Understand Granite Note',
    description: 'Inspect a note in context. Returns the note, its outgoing links, backlinks, unlinked mentions, recommendations, and its likely role in the graph.',
    inputSchema: {
      slug: z.string().describe('Slug of the note to inspect.'),
    },
    annotations: readOnlyAnnotations,
  }, async ({ slug }) => {
    const result = runtime.understandNote(slug);
    return {
      content: buildUnderstandNoteContent(result),
    };
  });

  server.registerTool('granite_about', {
    title: 'About Granite Entity',
    description: 'Everything the vault knows about one note, reached through its links rather than through its wording. Use this when you know an entity (a client, a person, a project) and want the notes that reference it — it is language-independent, so it works when the notes are in a different language than your question. Groups references by the referring note\'s type, carries the sentence explaining each link, and collapses a note that mentions the entity several times into one entry.',
    inputSchema: {
      slug: z.string().describe('Slug of the entity to read.'),
      types: z.array(z.string()).optional().describe('Restrict to these note types (e.g. ["meeting", "source"]). The counts returned describe the filtered view.'),
      direction: z.enum(['both', 'incoming', 'outgoing']).optional().describe('Which references to include. Defaults to both.'),
    },
    // A 25k-character markdown answer is hard to act on programmatically, and this is the
    // tool an agent reaches for when it cannot guess the wording. The structure is returned
    // alongside the prose so a caller can read the graph without parsing a document.
    outputSchema: {
      slug: z.string(),
      title: z.string(),
      type: z.string(),
      status: z.string(),
      counts: z.object({
        incoming: z.number().int().describe('References to this entity, after any type filter.'),
        outgoing: z.number().int().describe('References from this entity, after any type filter.'),
      }),
      unfiltered_counts: z.object({
        incoming: z.number().int(),
        outgoing: z.number().int(),
      }).optional().describe('Totals before the type filter, so "no reference of that type" is not confused with "no references".'),
      incoming: z.record(z.string(), z.array(z.object({
        slug: z.string(),
        title: z.string(),
        type: z.string(),
        contexts: z.array(z.string()).describe('The sentences that explain why the note points here.'),
      }))).describe('References grouped by the referring note\'s type.'),
      outgoing: z.record(z.string(), z.array(z.object({
        slug: z.string(),
        title: z.string(),
        type: z.string(),
        contexts: z.array(z.string()),
      }))).describe('Notes this entity links to, grouped by their type.'),
      filtered_by: z.array(z.string()).optional().describe('The types that were requested, when a filter was applied.'),
    },
    annotations: readOnlyAnnotations,
  }, async ({ slug, types, direction }) => {
    const entity = runtime.readEntity(slug, { types });
    return {
      content: [{
        type: 'text' as const,
        text: renderAboutMarkdown(entity, {
          incoming: direction !== 'outgoing',
          outgoing: direction !== 'incoming',
        }),
      }],
      structuredContent: entity as unknown as Record<string, unknown>,
    };
  });

  server.registerTool('granite_pool', {
    title: 'Granite Candidate Pool',
    description: 'Emit the bounded set of notes worth judging for a question, as a deterministic candidate pool ordered by graph distance. Use this before any semantic judging: Granite decides what is worth judging (free, no model, no network) and a judge decides which candidate answers the question. Ordering is by graph distance only, never by lexical overlap, so a note in another language still lands in the set. Each candidate carries deterministic sentences plus the total reachable count, so a caller can tell "nothing there" from "I capped it".',
    inputSchema: {
      anchor: z.string().describe('Slug of the note to grow the pool around.'),
      depth: z.number().int().min(1).optional().describe('Graph hops to walk. Defaults to 2.'),
      limit: z.number().int().min(1).optional().describe('Maximum candidates to return. Defaults to the whole nearest graph band, which is bounded by the vault; by_distance reports exactly what a smaller limit left out.'),
      sentences: z.number().int().min(0).optional().describe('Candidate sentences per note; 0 returns titles only. Defaults to 6, or to 0 when the nearest band is large — titles make a big neighbourhood affordable to see, and the response says when sentences were omitted.'),
    },
    // The pool is also returned as `structuredContent`, not only as prose, because the
    // deterministic half exists to feed the semantic half: a judge is handed this pool as
    // input. A caller forced to re-parse the markdown to recover the candidates would be
    // re-deriving the exact thing this tool exists to hand over, and would get it wrong.
    outputSchema: {
      anchor: z.string().describe('Slug the pool was grown around.'),
      anchor_title: z.string().describe('Title of the anchor note.'),
      reachable: z.number().int().describe('Notes reachable within the depth, before the limit was applied.'),
      candidates: z.array(z.object({
        slug: z.string(),
        title: z.string(),
        type: z.string(),
        distance: z.number().int().describe('Graph hops from the anchor. 1 = directly linked.'),
        sentences: z.array(z.string()).describe('Deterministic candidate sentences; empty when titles only were requested.'),
      })),
      by_distance: z.array(z.object({
        distance: z.number().int(),
        reachable: z.number().int().describe('Real notes at this distance, returned or not.'),
        shown: z.number().int().describe('How many of them this pool returned.'),
      })).describe('Per-hop reachable/shown counts. Use this to tell "the vault does not have it" from "the limit dropped it" before concluding anything is absent.'),
      sentences_omitted: z.boolean().optional().describe('True when this listing is titles only because the nearest band is large. Call again with sentences: 6 for the text a judge needs to cite.'),
    },
    annotations: readOnlyAnnotations,
  }, async ({ anchor, depth, limit, sentences }) => {
    const pool = runtime.buildPool(anchor, { depth, limit, sentences });
    return {
      content: [{ type: 'text' as const, text: renderPoolMarkdown(pool) }],
      structuredContent: pool as unknown as Record<string, unknown>,
    };
  });

  server.registerTool('granite_answer', {
    title: 'Answer A Question From The Vault',
    description: 'Answer a question from the vault: Granite bounds a candidate set around an anchor by graph distance, Jev (TypeSafe System One) selects which candidate answers it and which sentence carries the answer, and Granite applies the threshold. Use this when the question may not share wording with the notes — keyword search finds the answering note only 2 times in 15 when the question and the note are in different languages, while this path puts it in the candidate set 14 times in 15. Returns a verdict (answered / partial / absent), the ranked candidates with their relevance scores, and the cited sentence. Requires TYPESAFE_API_KEY; without it the tool reports itself unavailable and never silently degrades.',
    inputSchema: {
      question: z.string().describe('The question to answer from the vault.'),
      anchor: z.string().describe('Slug of the note to grow the candidate set around — an entity, a client, a project.'),
      depth: z.number().int().min(1).optional().describe('Graph hops to walk. Defaults to 2.'),
      limit: z.number().int().min(1).optional().describe('Maximum candidates to judge. Defaults to the whole nearest graph band, so the note that answers is not dropped by a round number; each candidate adds one score and one evidence question to a single batched request, so a larger pool costs little more time.'),
      sentences: z.number().int().min(0).optional().describe('Candidate sentences per note. Defaults to 6 here: judging needs the text, which is why this tool never takes the titles-only default that granite_pool uses for a large neighbourhood.'),
    },
    outputSchema: {
      status: z.string().describe('ok, or unavailable when no API key is configured.'),
      question: z.string(),
      anchor: z.string().optional(),
      model: z.string().optional(),
      verdict: z.enum(['answered', 'partial', 'absent']).optional(),
      top_score: z.number().optional().describe('Best relevance score, 0-3. The verdict derives from this.'),
      pool_has_answer: z.number().nullable().optional().describe('The absolute judgment, reported as context. Deliberately not the decision: it was measured giving a false negative on a pool whose answer sat at rank 3.'),
      ranked: z.array(z.object({
        slug: z.string(),
        title: z.string(),
        type: z.string(),
        distance: z.number().int(),
        score: z.number(),
        evidence: z.string().nullable().describe('The sentence Jev cited as carrying the answer, or null when it cited none.'),
      })).optional(),
      reachable: z.number().int().optional().describe('Notes reachable at the walked depth, before the candidate limit was applied.'),
      by_distance: z.array(z.object({
        distance: z.number().int(),
        reachable: z.number().int(),
        shown: z.number().int(),
      })).optional().describe('Per-hop reachable/shown counts. Read this before reporting absence: a verdict drawn from a truncated pool is a statement about the limit, not about the vault.'),
      reason: z.string().optional(),
    },
    annotations: readOnlyAnnotations,
  }, async ({ question, anchor, depth, limit, sentences }) => {
    const key = judgeApiKey();
    if (!key) {
      // A declared outputSchema means structured content is mandatory: the SDK rejects a
      // text-only result with an output-validation error, which would turn "Jev is not
      // configured" into an opaque protocol failure. Fail closed *and* stay well-formed.
      const unavailable = {
        status: 'unavailable' as const,
        question,
        anchor,
        reason: 'missing TYPESAFE_API_KEY',
      };
      return {
        content: [{
          type: 'text' as const,
          text: 'Jev is not configured: set TYPESAFE_API_KEY to answer questions semantically.\n\n'
            + 'Everything else in Granite works without it. `granite_pool` still returns the '
            + 'deterministic candidate set for this anchor if you want to judge it yourself.',
        }],
        structuredContent: unavailable as unknown as Record<string, unknown>,
      };
    }

    const pool = runtime.buildPool(anchor, {
      depth,
      limit,
      // Judging needs sentences: this tool exists to find the line that answers, so it never
      // takes the titles-only default a large neighbourhood gets from `granite_pool`.
      sentences: sentences ?? 6,
    });
    const verdict = await judgePool(pool, question, key, judgeModel());

    const lines: string[] = [
      `# ${verdict.verdict?.toUpperCase() ?? 'NO VERDICT'}`,
      '',
      `Top relevance ${verdict.top_score} (answered at ${ANSWERED_AT}, absent below ${ABSENT_BELOW}), `
      + `pool Noul ${verdict.pool_has_answer ?? 'n/a'} reported as context only.`,
      '',
    ];
    if (verdict.reason) lines.push(verdict.reason, '');
    const dropped = (verdict.by_distance ?? []).filter(band => band.shown < band.reachable);
    if (dropped.length > 0) {
      // An absence verdict from a capped pool is a claim about the limit, not the vault.
      lines.push(
        `Judged ${(verdict.ranked ?? []).length} of ${verdict.reachable} reachable note(s); `
        + `not judged: ${dropped.map(b => `${b.reachable - b.shown} at distance ${b.distance}`).join(', ')}.`,
        'Treat "absent" as provisional while anything is unjudged.',
        '',
      );
    }
    for (const candidate of (verdict.ranked ?? []).slice(0, 8)) {
      lines.push(`- **[${candidate.score}] ${candidate.title}** \`${candidate.slug}\` (distance ${candidate.distance})`);
      if (candidate.evidence) lines.push(`  - ${candidate.evidence}`);
    }

    return {
      content: [{ type: 'text' as const, text: lines.join('\n') }],
      structuredContent: verdict as unknown as Record<string, unknown>,
    };
  });

  if (canWrite) server.registerTool('granite_revise_note', {
    title: 'Revise Granite Note',
    description: 'Make a targeted revision to an existing note. Use this when a workflow prompt tells you exactly what to change, or when you need a precise manual intervention.',
    inputSchema: {
      slug: z.string().describe('Slug of the note to revise.'),
      type: buildTypeSchema(runtime, 'Optional new note type. Use this to promote a note between vault types (e.g. note → synthesis). Must be one of the vault-configured types.'),
      title: z.string().optional().describe('Replace the note title.'),
      body: z.string().optional().describe('Replace the entire note body.'),
      append: z.string().optional().describe('Append text to the existing note body.'),
      tags: z.array(z.string()).optional().describe('Tags to add.'),
      aliases: z.array(z.string()).optional().describe('Aliases to add.'),
      status: z.enum(['inbox', 'active', 'archived']).optional().describe('New note status.'),
      source: z.enum(['human', 'agent', 'extraction']).optional().describe('New note source.'),
      review_state: z.enum(['draft', 'reviewed', 'locked']).optional().describe('New review state.'),
      durability: z.enum(['canonical', 'working', 'ephemeral']).optional().describe('New durability.'),
      derived_from: z.array(z.string()).optional().describe('New derived_from references.'),
      fields: z.record(z.string(), z.unknown()).optional().describe('Type-specific frontmatter fields to set or overwrite (e.g. { date: "2026-04-17" } when promoting to meeting). Keys reserved by the system are ignored — use the dedicated inputs for those. See granite://vault/types for each type\'s required fields.'),
    },
    annotations: writeAnnotations,
  }, async ({ slug, ...updates }) => {
    const result = runtime.reviseNote(slug, updates);
    return toolResult(renderMutationResultMarkdown('Revised', result.note, result.recommendations, result.validation));
  });

  server.registerTool('granite_resolve', {
    title: 'Resolve Granite Reference',
    description: 'Deterministically resolve free text (e.g. a name, title, or alias) into an existing note slug. Use this before writing wikilinks or typed fields to avoid creating duplicates. Returns ranked matches and, if nothing matches, an optional stub suggestion.',
    inputSchema: {
      text: z.string().describe('Free text to resolve — name, title, or alias.'),
      target_type: z.string().optional().describe('Restrict matches to a given note type (e.g. "person", "organization").'),
      limit: z.number().int().min(1).max(20).optional().describe('Maximum matches to return. Defaults to 5.'),
    },
    annotations: readOnlyAnnotations,
  }, async ({ text, target_type, limit }) => {
    const result = runtime.resolve(text, { target_type, limit });
    const summary = result.matches.length > 0
      ? `# Resolve Matches\n\n${result.matches.map(m => `- **${m.title}** (${m.slug}, ${m.type}) — ${m.reason} score=${m.score.toFixed(2)}`).join('\n')}`
      : `# Resolve Matches\n\nNo matches for "${text}".${result.suggested_stub ? `\n\nSuggested stub: ${result.suggested_stub.type} "${result.suggested_stub.title}" → ${result.suggested_stub.slug}` : ''}`;
    return toolResult(summary);
  });

  server.registerTool('granite_query', {
    title: 'Query Granite Vault',
    description: 'Run a structured query over notes by type and indexed fields. Use this when you want "all meetings with Monka Care since April" or "all people at organization X". Only fields declared in indexed_fields on the type are queryable.',
    inputSchema: {
      type: z.string().optional().describe('Restrict to a note type.'),
      where: z.record(z.string(), z.any()).optional().describe('Equality filters or {eq,in,gte,lte} operators keyed by field name.'),
      sort_field: z.string().optional().describe('Field to sort by (modified, created, title, or an indexed field).'),
      sort_dir: z.enum(['asc', 'desc']).optional().describe('Sort direction. Defaults to desc.'),
      limit: z.number().int().min(1).max(200).optional().describe('Maximum results. Defaults to 25.'),
    },
    annotations: readOnlyAnnotations,
  }, async ({ type, where, sort_field, sort_dir, limit }) => {
    const result = runtime.query({
      type,
      where: where as Query['where'],
      sort: sort_field ? { field: sort_field, dir: sort_dir ?? 'desc' } : undefined,
      limit,
    });
    return toolResult(renderQueryResultsMarkdown(result.results));
  });

  server.registerTool('granite_compile_context', {
    title: 'Compile Granite Context',
    description: 'Compile a typed brief around a topic or a specific note slug. Walks the graph and uses typed filters (people at an org, meetings for an org, sources on a topic). Deterministic — no LLM.',
    inputSchema: {
      topic: z.string().optional().describe('Topic to compile context around.'),
      slug: z.string().optional().describe('Note slug to compile context for.'),
      limit: z.number().int().min(1).max(100).optional().describe('Max entries per section. Defaults to 20.'),
    },
    annotations: readOnlyAnnotations,
  }, async ({ topic, slug, limit }) => {
    const result = runtime.compileContext({ topic, slug, limit });
    const summary = [
      `# Context: ${result.title}`,
      '',
      ...result.sections.flatMap(s => [
        `## ${s.heading}`,
        '',
        ...s.entries.map(e => `- **${e.title}** (${e.slug}, ${e.type}) — ${e.reason}`),
        '',
      ]),
    ].join('\n');
    return toolResult(summary);
  });

  if (canWrite) server.registerTool('granite_dispose_note', {
    title: 'Dispose Granite Note',
    description: 'Remove a note from the active knowledge loop. Archive by default; delete only when you are intentionally discarding the note.',
    inputSchema: {
      slug: z.string().describe('Slug of the note to archive or delete.'),
      mode: z.enum(['archive', 'delete']).optional().describe('How to dispose of the note. Defaults to archive.'),
    },
    annotations: writeAnnotations,
  }, async ({ slug, mode }) => {
    const result = runtime.disposeNote(slug, mode ?? 'archive');
    return toolResult(renderDisposeNoteMarkdown(result));
  });
}

function registerResources(server: McpServer, runtime: GraniteMcpRuntime): void {
  server.registerResource('granite-note-types', 'granite://vault/types', {
    title: 'Granite Note Types',
    description: 'Structured list of the note types configured in the current vault.',
    mimeType: 'text/markdown',
  }, async () => ({
    contents: [{
      uri: 'granite://vault/types',
      text: renderNoteTypesMarkdown(runtime.listNoteTypes(), runtime.getDefaultNoteType()),
      mimeType: 'text/markdown',
    }],
  }));

  const noteTemplate = new ResourceTemplate('granite://notes/{slug}', {
    list: undefined,
    complete: {
      slug: async (value) => runtime.completeSlugs(value),
    },
  });

  server.registerResource('granite-note', noteTemplate, {
    title: 'Granite Note',
    description: 'Read a Granite note as markdown with YAML frontmatter.',
    mimeType: 'text/markdown',
  }, async (uri, variables) => {
    const variable = variables.slug;
    const slug = Array.isArray(variable) ? variable[0] : variable;
    if (!slug) {
      throw new Error('Resource URI is missing the note slug.');
    }

    return {
      contents: [{
        uri: uri.toString(),
        text: runtime.readNoteMarkdown(decodeURIComponent(slug)),
        mimeType: 'text/markdown',
      }],
    };
  });

  const assetTemplate = new ResourceTemplate('granite://assets/{filename}', {
    list: undefined,
    complete: {
      filename: async (value) => runtime.completeAssets(value),
    },
  });

  server.registerResource('granite-asset', assetTemplate, {
    title: 'Granite Asset',
    description: 'Read an imported Granite asset. Text files are returned as text; binary files are returned as base64 blobs.',
    mimeType: 'application/octet-stream',
  }, async (_uri, variables) => {
    const variable = variables.filename;
    const fileName = Array.isArray(variable) ? variable[0] : variable;
    if (!fileName) {
      throw new Error('Resource URI is missing the asset filename.');
    }

    return {
      contents: [runtime.readAsset(decodeURIComponent(fileName))],
    };
  });
}

function registerPrompts(server: McpServer, runtime: GraniteMcpRuntime): void {
  server.registerPrompt('granite_refine_note', {
    title: 'Refine Granite Note',
    description: 'Turn a raw capture or draft into a durable, well-structured note. Use this on inbox notes to promote them to active status.',
    argsSchema: {
      slug: z.string().describe('Slug of the note to refine.'),
    },
  }, async ({ slug }) => {
    const note = runtime.getNote(slug);
    const linkedAsset = getLinkedAsset(note);

    return {
      description: `Refine ${note.slug} into a durable Granite note.`,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Refine the attached Granite note into a durable, well-structured note.',
              'Keep the meaning intact, avoid inventing facts, preserve useful wikilinks, and use Granite-style headings when appropriate.',
              linkedAsset && !isDocumentParsingDisabled() ? 'This note is linked to an imported document. If you need to understand that document, call granite_extract_document with the note frontmatter document_path before summarizing or extracting facts.' : '',
              'When you are ready to apply the result, use granite_revise_note rather than low-level CRUD operations.',
            ].filter(Boolean).join(' '),
          },
        },
        {
          role: 'user',
          content: {
            type: 'resource',
            resource: {
              uri: note.resource_uri,
              text: runtime.readNoteMarkdown(slug),
              mimeType: 'text/markdown',
            },
          },
        },
      ],
    };
  });

  server.registerPrompt('granite_process_inbox', {
    title: 'Process Granite Inbox',
    description: 'Review all inbox notes and decide what to do with each: refine into a durable note, merge into an existing note, archive, or delete. This is the compile phase of the knowledge loop.',
  }, async () => {
    const inboxNotes = runtime.listNotes({ status: 'inbox', limit: 50 });
    const overview = runtime.getVaultOverview(5);

    return {
      description: 'Process the inbox: triage, refine, and compile captured notes.',
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Process the Granite inbox. For each inbox note below, decide:',
              '',
              '1. **Refine** — If it contains a durable idea, refine it into a well-structured note (update body, set status: active, review_state: reviewed).',
              '2. **Merge** — If it overlaps with an existing note, append the new information to that note and archive the inbox note.',
              '3. **Promote to source** — If it\'s raw reference material, update its type to source and refine it.',
              '4. **Archive** — If it\'s been processed or is no longer relevant, set status: archived.',
              '',
              'Use granite_understand_note before changing a note, granite_revise_note to apply precise edits, and granite_dispose_note to archive anything that should leave the active loop.',
              ...(isDocumentParsingDisabled() ? [] : [
                'If granite_understand_note shows that a source note has an imported document attached, call granite_extract_document with the note frontmatter document_path before summarizing, extracting facts, or promoting it.',
              ]),
              '',
              `Vault context: ${overview.note_count} notes total (${Object.entries(overview.notes_by_type).map(([t, c]) => `${c} ${t}s`).join(', ')}).`,
              '',
              `Inbox notes to process (${inboxNotes.length}):`,
              '',
              ...inboxNotes.map(n => `- **${n.slug}**: "${n.title}" (type: ${n.type}, created: ${n.created})`),
            ].join('\n'),
          },
        },
      ],
    };
  });

  server.registerPrompt('granite_compile_topic', {
    title: 'Compile Granite Topic',
    description: 'Analyze a set of related notes and compile them into a synthesis note — the most valuable operation in the knowledge loop. Creates durable compiled knowledge from scattered notes.',
    argsSchema: {
      topic: z.string().describe('The topic or theme to synthesize notes around.'),
    },
  }, async ({ topic }) => {
    const searchResults = runtime.search(topic, 20);
    const noteDetails = searchResults.map(r => {
      try { return runtime.getNote(r.slug); } catch { return null; }
    }).filter(Boolean);

    return {
      description: `Compile a synthesis on "${topic}" from ${noteDetails.length} related notes.`,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Compile a synthesis note on "${topic}" from the related notes below.`,
              '',
              'A good synthesis:',
              '- Connects ideas across multiple sources and notes',
              '- Identifies patterns, tensions, and open questions',
              '- Uses [[wikilinks]] to link back to every source note',
              '- Sets derived_from to the slugs of the notes it draws from',
              '- Is more valuable than any individual note because it creates new understanding',
              '',
              'Steps:',
              ...[
                'Read the related notes below',
                ...(isDocumentParsingDisabled() ? [] : [
                  'If a related source note has an imported document attached, call granite_extract_document with that note\'s document_path before summarizing or extracting facts from that source',
                ]),
                'Draft the synthesis body and create it with granite_capture_knowledge (set type: synthesis and provide an explicit title)',
                'Write a body that connects the key ideas, with [[wikilinks]] to sources',
                'Set derived_from to the source note slugs',
                'Run granite_understand_note on the new synthesis to inspect how well it is connected',
              ].map((step, index) => `${index + 1}. ${step}`),
              '',
              `Related notes (${noteDetails.length} found for "${topic}"):`,
              '',
              ...noteDetails.map(n => n ? formatCompileTopicNote(n) : ''),
            ].join('\n'),
          },
        },
      ],
    };
  });

}

function toolResult(summary: string) {
  return {
    content: [{ type: 'text' as const, text: summary }],
  };
}

function createNoteResourceLink(name: string, uri: string) {
  return {
    type: 'resource_link' as const,
    name,
    uri,
    mimeType: 'text/markdown',
    description: 'Read the markdown resource for this note.',
  };
}

function createAssetResourceLink(name: string, uri: string, mimeType: string) {
  return {
    type: 'resource_link' as const,
    name,
    uri,
    mimeType,
    description: 'Read the imported source document linked to this note.',
  };
}

function buildUnderstandNoteContent(result: Parameters<typeof renderUnderstandNoteMarkdown>[0]) {
  const content: Array<
    { type: 'text'; text: string }
    | ReturnType<typeof createNoteResourceLink>
    | ReturnType<typeof createAssetResourceLink>
  > = [{ type: 'text', text: renderUnderstandNoteMarkdown(result) }];

  if (result.note.resource_uri) {
    content.push(createNoteResourceLink(result.note.title, result.note.resource_uri));
  }

  const linkedAsset = result.note.frontmatter ? getLinkedAsset({ frontmatter: result.note.frontmatter }) : null;
  if (linkedAsset) {
    content.push(createAssetResourceLink(linkedAsset.file, linkedAsset.resource_uri, linkedAsset.mime_type));
  }

  return content;
}

function getLinkedAsset(note: { frontmatter: Record<string, unknown> }) {
  const file = typeof note.frontmatter.document_file === 'string' ? note.frontmatter.document_file : null;
  const resourceUri = typeof note.frontmatter.document_resource_uri === 'string' ? note.frontmatter.document_resource_uri : null;
  const mimeType = typeof note.frontmatter.document_mime === 'string' ? note.frontmatter.document_mime : 'application/octet-stream';

  if (!file || !resourceUri) {
    return null;
  }

  return {
    file,
    resource_uri: resourceUri,
    mime_type: mimeType,
  };
}

function formatCompileTopicNote(note: { title: string; slug: string; type: string; body: string; frontmatter: Record<string, unknown> }) {
  const linkedAsset = getLinkedAsset(note);
  return [
    `### ${note.title} (${note.slug}, type: ${note.type})`,
    ...(linkedAsset ? [`Imported document: ${linkedAsset.resource_uri} (${linkedAsset.mime_type})`] : []),
    note.body.slice(0, 500) + (note.body.length > 500 ? '...' : ''),
    '',
  ].join('\n');
}

export function createGraniteMcpHttpApp(runtime: GraniteMcpRuntime, options: GraniteMcpHttpServerOptions): Hono {
  const app = new Hono();
  const allowedHosts = buildAllowedHosts(options.host, options.port);
  const allowedOrigins = buildAllowedOrigins(options.host, options.port, options.allowedOrigins ?? []);
  const authToken = options.authToken?.trim();
  const role = options.role ?? 'write';

  const guard: MiddlewareHandler = async (c, next) => {
    const requestHost = (c.req.header('host') ?? '').toLowerCase();
    if (allowedHosts.size > 0 && !allowedHosts.has(requestHost)) {
      return c.json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Forbidden host header.' },
        id: null,
      }, 403);
    }

    const origin = c.req.header('origin');
    if (origin && !allowedOrigins.has(origin)) {
      return c.json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Forbidden origin.' },
        id: null,
      }, 403);
    }

    if (c.req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin, allowedOrigins),
      });
    }

    if (authToken) {
      const token = readBearerToken(c.req.header('authorization'));
      if (token !== authToken) {
        return c.json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Unauthorized.' },
          id: null,
        }, 401);
      }
    }

    await next();
  };

  app.use('/mcp', guard);

  if (options.webApi) {
    // Read-only vault API for the local UI's instance switcher — same host,
    // origin, and bearer guard as /mcp; writes are never mounted here.
    app.use('/api/*', guard);
    app.use('/assets/*', guard);
    registerReadOnlyApiRoutes(app, {
      vaultRoot: runtime.vaultRoot,
      getConfig: () => runtime.getConfig(),
    });
  }

  app.get('/health', c => c.json({ status: 'ok', name: 'granite-mcp', version: GRANITE_VERSION }));

  app.all('/mcp', async (c) => {
    const origin = c.req.header('origin');
    const server = createGraniteMcpServer(runtime, { role });
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: options.jsonResponse ?? false,
    });

    try {
      await server.connect(transport);
      const response = await transport.handleRequest(c.req.raw);
      const managedResponse = await withResponseCleanup(response, async () => {
        await server.close();
      });
      return withCors(managedResponse, origin, allowedOrigins);
    } catch (error) {
      await server.close();
      throw error;
    }
  });

  return app;
}

function buildAllowedHosts(host: string, port: number): Set<string> {
  const normalizedHost = host.toLowerCase();
  if (isWildcardBindHost(normalizedHost)) {
    return new Set<string>();
  }

  const allowed = new Set<string>([`${normalizedHost}:${port}`]);

  if (normalizedHost === '127.0.0.1' || normalizedHost === 'localhost') {
    allowed.add(`127.0.0.1:${port}`);
    allowed.add(`localhost:${port}`);
  }

  if (normalizedHost === '::1' || normalizedHost === '[::1]') {
    allowed.add(`[::1]:${port}`);
  }

  return allowed;
}

function isWildcardBindHost(host: string): boolean {
  const normalizedHost = host.toLowerCase();
  return normalizedHost === '0.0.0.0' || normalizedHost === '::' || normalizedHost === '[::]';
}

export function requiresMcpHttpAuth(host: string): boolean {
  return !isLoopbackBindHost(host);
}

function isLoopbackBindHost(host: string): boolean {
  const normalizedHost = host.toLowerCase();
  if (normalizedHost === 'localhost' || normalizedHost === '::1' || normalizedHost === '[::1]') {
    return true;
  }

  const ipv4 = net.isIP(normalizedHost) === 4 ? normalizedHost : '';
  return ipv4.startsWith('127.');
}

function buildAllowedOrigins(host: string, port: number, extraOrigins: string[]): Set<string> {
  const allowed = new Set<string>(extraOrigins);
  const normalizedHost = host.toLowerCase();

  if (normalizedHost === '::1' || normalizedHost === '[::1]') {
    allowed.add(`http://[::1]:${port}`);
  } else if (normalizedHost !== '0.0.0.0' && normalizedHost !== '::' && normalizedHost !== '[::]') {
    allowed.add(`http://${normalizedHost}:${port}`);
  }

  if (normalizedHost === '127.0.0.1' || normalizedHost === 'localhost') {
    allowed.add(`http://127.0.0.1:${port}`);
    allowed.add(`http://localhost:${port}`);
  }

  return allowed;
}

function withCors(response: Response, origin: string | undefined, allowedOrigins: Set<string>): Response {
  const headers = new Headers(response.headers);

  for (const [key, value] of corsHeaders(origin, allowedOrigins)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function corsHeaders(origin: string | undefined, allowedOrigins: Set<string>): Headers {
  const headers = new Headers();
  if (origin && allowedOrigins.has(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version, Last-Event-ID');
    headers.set('Access-Control-Expose-Headers', 'MCP-Session-Id, MCP-Protocol-Version');
    headers.set('Vary', 'Origin');
  }
  return headers;
}

function readBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

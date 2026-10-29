import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadResourceResult } from '@modelcontextprotocol/sdk/types.js';
import { renderNoteTypesMarkdown } from '../../shared/mcp-markdown.js';
import type { GraniteMcpRuntime } from './runtime.js';

export const VAULT_TYPES_URI = 'granite://vault/types';

interface GraniteResource {
  name: string;
  uri: string;
  template?: ResourceTemplate;
  metadata: { title: string; description: string; mimeType: string };
  read: (uri: URL, variables: Record<string, string | string[]>) => ReadResourceResult;
}

export function createGraniteResources(runtime: GraniteMcpRuntime) {
  const definitions: GraniteResource[] = [];
  // Registration, tool routing, and supported-URI errors share this registry.
  const register = (
    name: string,
    uri: string | ResourceTemplate,
    metadata: GraniteResource['metadata'],
    read: GraniteResource['read'],
  ) => {
    definitions.push({
      name,
      uri: typeof uri === 'string' ? uri : uri.uriTemplate.toString(),
      template: typeof uri === 'string' ? undefined : uri,
      metadata,
      read,
    });
  };
  register('granite-note-types', VAULT_TYPES_URI, {
    title: 'Granite Note Types',
    description: 'Structured list of the note types configured in the current vault.',
    mimeType: 'text/markdown',
  }, () => ({
    contents: [{
      uri: VAULT_TYPES_URI,
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

  register('granite-note', noteTemplate, {
    title: 'Granite Note',
    description: 'Read a Granite note as markdown with YAML frontmatter.',
    mimeType: 'text/markdown',
  }, (uri, variables) => {
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

  register('granite-asset', assetTemplate, {
    title: 'Granite Asset',
    description: 'Read an imported Granite asset. Text files are returned as text; binary files are returned as base64 blobs.',
    mimeType: 'application/octet-stream',
  }, (_uri, variables) => {
    const variable = variables.filename;
    const fileName = Array.isArray(variable) ? variable[0] : variable;
    if (!fileName) {
      throw new Error('Resource URI is missing the asset filename.');
    }

    return {
      contents: [runtime.readAsset(decodeURIComponent(fileName))],
    };
  });

  return {
    definitions,
    read(uri: string): ReadResourceResult {
      // Match the SDK's URL normalization before selecting a resource/template.
      const url = URL.canParse(uri) ? new URL(uri) : undefined;
      if (url) {
        const normalizedUri = url.toString();
        const fixed = definitions.find(resource => !resource.template && resource.uri === normalizedUri);
        if (fixed) return fixed.read(url, {});
        for (const resource of definitions) {
          const variables = resource.template?.uriTemplate.match(normalizedUri);
          if (variables) {
            try {
              return resource.read(url, variables);
            } catch (error) {
              if (!(error instanceof URIError)) throw error;
              break;
            }
          }
        }
      }
      throw new Error(`Unknown Granite resource URI: ${uri}. Supported URIs/templates: ${definitions.map(resource => resource.uri).join(', ')}`);
    },
  };
}

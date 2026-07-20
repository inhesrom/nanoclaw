import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  GoogleApiError,
  GoogleDocsClient,
  GoogleDocsInputError,
} from './gdocs-client.js';

const client = new GoogleDocsClient();
const server = new McpServer({ name: 'gdocs', version: '1.0.0' });

function success(value: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
  };
}

function failure(error: unknown) {
  const safeMessage =
    error instanceof GoogleApiError || error instanceof GoogleDocsInputError
      ? error.message
      : 'Google Docs request failed without returning provider details.';
  return {
    content: [
      {
        type: 'text' as const,
        text: safeMessage,
      },
    ],
    isError: true,
  };
}

async function run(operation: () => Promise<unknown>) {
  try {
    return success(await operation());
  } catch (error) {
    return failure(error);
  }
}

const documentInput = z
  .string()
  .min(1)
  .describe('A docs.google.com document URL or bare Google document ID');
const revisionInput = z
  .string()
  .min(1)
  .optional()
  .describe(
    'Optional revision ID from get_document. The edit fails rather than overwriting newer collaborator changes if it is stale.',
  );

server.tool(
  'search_documents',
  'Search Google Drive for Google Docs by title or full text. This is read-only and returns a continuation token when more results exist.',
  {
    query: z
      .string()
      .min(1)
      .describe('Text to find in the document name or content'),
    page_size: z.number().int().min(1).max(100).default(10),
    page_token: z.string().min(1).optional(),
  },
  (args) =>
    run(() =>
      client.searchDocuments(args.query, args.page_size, args.page_token),
    ),
);

server.tool(
  'get_document',
  'Read a Google Doc, including text from every tab. Set include_structure only when raw structural data is needed for advanced formatting edits.',
  {
    document: documentInput,
    include_structure: z.boolean().default(false),
  },
  (args) =>
    run(() => client.getDocument(args.document, args.include_structure)),
);

server.tool(
  'create_document',
  'Create a Google Doc and optionally add initial plain text. Use only when the user explicitly asks to create a document.',
  {
    title: z.string().min(1).max(500),
    initial_text: z.string().optional(),
  },
  (args) => run(() => client.createDocument(args.title, args.initial_text)),
);

server.tool(
  'append_text',
  'Append plain text to the end of a Google Doc or one of its tabs. Use only when the user explicitly asks to edit the document.',
  {
    document: documentInput,
    text: z.string().min(1),
    required_revision_id: revisionInput,
    tab_id: z.string().min(1).optional(),
  },
  (args) =>
    run(() =>
      client.appendText(
        args.document,
        args.text,
        args.required_revision_id,
        args.tab_id,
      ),
    ),
);

server.tool(
  'replace_all_text',
  'Replace every exact text match in a Google Doc, optionally limited to specific tabs. Use only on an explicit user edit request.',
  {
    document: documentInput,
    find: z.string().min(1),
    replacement: z.string(),
    required_revision_id: revisionInput,
    match_case: z.boolean().default(false),
    tab_ids: z.array(z.string().min(1)).min(1).optional(),
  },
  (args) =>
    run(() =>
      client.replaceAllText(
        args.document,
        args.find,
        args.replacement,
        args.required_revision_id,
        args.match_case,
        args.tab_ids,
      ),
    ),
);

server.tool(
  'batch_update_document',
  'Apply official Google Docs batchUpdate requests for advanced formatting or structural edits. Use get_document(include_structure=true) first and use required_revision_id for optimistic concurrency.',
  {
    document: documentInput,
    requests: z.array(z.record(z.string(), z.unknown())).min(1).max(1000),
    required_revision_id: revisionInput,
  },
  (args) =>
    run(() =>
      client.batchUpdateDocument(
        args.document,
        args.requests,
        args.required_revision_id,
      ),
    ),
);

await server.connect(new StdioServerTransport());

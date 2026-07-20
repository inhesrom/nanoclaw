const DOCS_API_ROOT = 'https://docs.googleapis.com/v1/documents';
const DRIVE_FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
const GOOGLE_DOC_MIME_TYPE = 'application/vnd.google-apps.document';
const DEFAULT_ACCESS_TOKEN = 'placeholder';

export type FetchLike = typeof fetch;

interface GoogleErrorPayload {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    errors?: Array<{ reason?: string; message?: string }>;
  };
}

interface StructuralElement {
  paragraph?: {
    elements?: Array<{
      textRun?: { content?: string };
      autoText?: { content?: string };
    }>;
  };
  table?: {
    tableRows?: Array<{
      tableCells?: Array<{ content?: StructuralElement[] }>;
    }>;
  };
  tableOfContents?: { content?: StructuralElement[] };
}

interface DocumentTab {
  tabProperties?: {
    tabId?: string;
    title?: string;
    parentTabId?: string;
    index?: number;
    nestingLevel?: number;
  };
  documentTab?: {
    body?: { content?: StructuralElement[] };
    [key: string]: unknown;
  };
  childTabs?: DocumentTab[];
}

interface GoogleDocument {
  documentId?: string;
  title?: string;
  revisionId?: string;
  body?: { content?: StructuralElement[] };
  tabs?: DocumentTab[];
  [key: string]: unknown;
}

interface BatchUpdateResponse {
  documentId?: string;
  replies?: unknown[];
  writeControl?: { requiredRevisionId?: string; targetRevisionId?: string };
}

export interface DocumentTabResult {
  tab_id: string | null;
  title: string;
  parent_tab_id?: string;
  index?: number;
  nesting_level?: number;
  text: string;
  structure?: unknown;
}

export interface DocumentResult {
  document_id: string;
  title: string;
  revision_id: string | null;
  url: string;
  tabs: DocumentTabResult[];
}

export interface DocumentWriteResult {
  document_id: string;
  title: string;
  revision_id: string | null;
  url: string;
  replies: unknown[];
}

export class GoogleApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind:
      | 'authentication'
      | 'insufficient_scope'
      | 'permission_denied'
      | 'not_found'
      | 'stale_revision'
      | 'rate_limited'
      | 'api_error',
  ) {
    super(message);
    this.name = 'GoogleApiError';
  }
}

export class GoogleDocsInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GoogleDocsInputError';
  }
}

/** Accept a Google Docs sharing URL or a bare document ID. */
export function parseDocumentId(document: string): string {
  const input = document.trim();
  if (!input) {
    throw new GoogleDocsInputError(
      'A Google Docs URL or document ID is required.',
    );
  }

  let candidate = input;
  if (/^https?:\/\//i.test(input)) {
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new GoogleDocsInputError('The Google Docs URL is invalid.');
    }
    if (url.hostname !== 'docs.google.com') {
      throw new GoogleDocsInputError(
        'Only docs.google.com document URLs are supported.',
      );
    }
    const match = url.pathname.match(
      /^\/document\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]+)(?:\/|$)/,
    );
    if (!match) {
      throw new GoogleDocsInputError(
        'The Google Docs URL does not contain a document ID.',
      );
    }
    candidate = match[1];
  }

  if (!/^[A-Za-z0-9_-]+$/.test(candidate)) {
    throw new GoogleDocsInputError(
      'The Google document ID contains invalid characters.',
    );
  }
  return candidate;
}

/** Escape a string embedded inside a single-quoted Google Drive query literal. */
export function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

export function buildDriveSearchQuery(query: string): string {
  const escaped = escapeDriveQueryLiteral(query.trim());
  return [
    `mimeType = '${GOOGLE_DOC_MIME_TYPE}'`,
    'trashed = false',
    `(name contains '${escaped}' or fullText contains '${escaped}')`,
  ].join(' and ');
}

export function extractStructuralText(
  elements: StructuralElement[] | undefined,
): string {
  if (!elements) return '';
  let text = '';
  for (const element of elements) {
    if (element.paragraph?.elements) {
      for (const paragraphElement of element.paragraph.elements) {
        text +=
          paragraphElement.textRun?.content ??
          paragraphElement.autoText?.content ??
          '';
      }
    }
    if (element.table?.tableRows) {
      for (const row of element.table.tableRows) {
        const cells = (row.tableCells ?? []).map((cell) =>
          extractStructuralText(cell.content).replace(/\n+$/g, ''),
        );
        text += `${cells.join('\t')}\n`;
      }
    }
    if (element.tableOfContents?.content) {
      text += extractStructuralText(element.tableOfContents.content);
    }
  }
  return text;
}

export function extractDocumentTabs(
  document: GoogleDocument,
  includeStructure = false,
): DocumentTabResult[] {
  if (!document.tabs?.length) {
    const legacy: DocumentTabResult = {
      tab_id: null,
      title: document.title ?? 'Untitled document',
      text: extractStructuralText(document.body?.content),
    };
    if (includeStructure) legacy.structure = { body: document.body ?? {} };
    return [legacy];
  }

  const results: DocumentTabResult[] = [];
  const walk = (tab: DocumentTab): void => {
    const properties = tab.tabProperties ?? {};
    const result: DocumentTabResult = {
      tab_id: properties.tabId ?? null,
      title: properties.title ?? 'Untitled tab',
      text: extractStructuralText(tab.documentTab?.body?.content),
    };
    if (properties.parentTabId) result.parent_tab_id = properties.parentTabId;
    if (properties.index !== undefined) result.index = properties.index;
    if (properties.nestingLevel !== undefined) {
      result.nesting_level = properties.nestingLevel;
    }
    if (includeStructure) result.structure = tab.documentTab ?? {};
    results.push(result);
    for (const child of tab.childTabs ?? []) walk(child);
  };

  for (const tab of document.tabs) walk(tab);
  return results;
}

function documentUrl(documentId: string): string {
  return `https://docs.google.com/document/d/${documentId}/edit`;
}

function providerName(url: URL): 'Google Docs' | 'Google Drive' {
  return url.hostname === 'docs.googleapis.com'
    ? 'Google Docs'
    : 'Google Drive';
}

function errorDetails(payload: GoogleErrorPayload): string {
  const error = payload.error;
  return [
    error?.status,
    error?.message,
    ...(error?.errors ?? []).flatMap((item) => [item.reason, item.message]),
  ]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

/** Convert provider responses into actionable errors without returning raw bodies. */
export async function sanitizedGoogleApiError(
  response: Response,
  url: URL,
  operation: string,
): Promise<GoogleApiError> {
  let payload: GoogleErrorPayload = {};
  try {
    const raw = (await response.text()).slice(0, 128 * 1024);
    payload = JSON.parse(raw) as GoogleErrorPayload;
  } catch {
    // Non-JSON gateway/provider bodies are deliberately not reflected to the agent.
  }

  const status = response.status;
  const provider = providerName(url);
  const details = errorDetails(payload);

  if (status === 401) {
    return new GoogleApiError(
      `${provider} authentication failed (401). Reconnect ${provider} in OneCLI; this request was not retried.`,
      status,
      'authentication',
    );
  }
  if (
    status === 403 &&
    /(insufficient|scope|access_token_scope_insufficient)/.test(details)
  ) {
    return new GoogleApiError(
      `${provider} lacks the OAuth scope required to ${operation} (403). Reconnect ${provider} in OneCLI with the required permission.`,
      status,
      'insufficient_scope',
    );
  }
  if (status === 403) {
    return new GoogleApiError(
      `${provider} denied permission to ${operation} (403). The connected account may not have access to this document.`,
      status,
      'permission_denied',
    );
  }
  if (status === 404) {
    return new GoogleApiError(
      `The Google document was not found (404) or is not shared with the connected account.`,
      status,
      'not_found',
    );
  }
  if (
    status === 409 ||
    status === 412 ||
    /(requiredrevisionid|required revision|stale revision|revision.+changed|aborted|failed_precondition)/.test(
      details,
    )
  ) {
    return new GoogleApiError(
      `The Google document changed since the required revision. Read the latest revision before attempting another edit; no changes were applied.`,
      status,
      'stale_revision',
    );
  }
  if (status === 429) {
    return new GoogleApiError(
      `${provider} rate-limited the ${operation} request (429). Try again later.`,
      status,
      'rate_limited',
    );
  }
  return new GoogleApiError(
    `${provider} could not ${operation} (HTTP ${status}).`,
    status,
    'api_error',
  );
}

export class GoogleDocsClient {
  constructor(
    private readonly fetchImpl: FetchLike = fetch,
    private readonly accessToken = process.env.GOOGLE_API_ACCESS_TOKEN ||
      DEFAULT_ACCESS_TOKEN,
  ) {}

  private async request<T>(
    url: URL,
    operation: string,
    init: RequestInit = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${this.accessToken}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
          ...init.headers,
        },
      });
    } catch {
      throw new GoogleApiError(
        `${providerName(url)} could not reach the provider through OneCLI. Check that the gateway is available; no credential details were returned.`,
        0,
        'api_error',
      );
    }
    if (!response.ok)
      throw await sanitizedGoogleApiError(response, url, operation);
    try {
      return (await response.json()) as T;
    } catch {
      throw new GoogleApiError(
        `${providerName(url)} returned an invalid response while trying to ${operation}.`,
        response.status,
        'api_error',
      );
    }
  }

  async searchDocuments(
    query: string,
    pageSize = 10,
    pageToken?: string,
  ): Promise<{
    documents: Array<{
      document_id: string;
      title: string;
      url: string;
      modified_time: string | null;
      owners: Array<{
        display_name: string | null;
        email_address: string | null;
      }>;
    }>;
    next_page_token: string | null;
  }> {
    const url = new URL(DRIVE_FILES_ENDPOINT);
    url.searchParams.set('q', buildDriveSearchQuery(query));
    url.searchParams.set('pageSize', String(pageSize));
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    url.searchParams.set('orderBy', 'modifiedTime desc');
    url.searchParams.set(
      'fields',
      'nextPageToken,files(id,name,modifiedTime,webViewLink,owners(displayName,emailAddress))',
    );
    const result = await this.request<{
      files?: Array<{
        id?: string;
        name?: string;
        modifiedTime?: string;
        webViewLink?: string;
        owners?: Array<{ displayName?: string; emailAddress?: string }>;
      }>;
      nextPageToken?: string;
    }>(url, 'search documents');

    return {
      documents: (result.files ?? [])
        .filter((file): file is typeof file & { id: string } =>
          Boolean(file.id),
        )
        .map((file) => ({
          document_id: file.id,
          title: file.name ?? 'Untitled document',
          url: file.webViewLink ?? documentUrl(file.id),
          modified_time: file.modifiedTime ?? null,
          owners: (file.owners ?? []).map((owner) => ({
            display_name: owner.displayName ?? null,
            email_address: owner.emailAddress ?? null,
          })),
        })),
      next_page_token: result.nextPageToken ?? null,
    };
  }

  async getDocument(
    document: string,
    includeStructure = false,
  ): Promise<DocumentResult> {
    const documentId = parseDocumentId(document);
    const url = new URL(`${DOCS_API_ROOT}/${encodeURIComponent(documentId)}`);
    url.searchParams.set('includeTabsContent', 'true');
    const result = await this.request<GoogleDocument>(url, 'read the document');
    const resolvedId = result.documentId ?? documentId;
    return {
      document_id: resolvedId,
      title: result.title ?? 'Untitled document',
      revision_id: result.revisionId ?? null,
      url: documentUrl(resolvedId),
      tabs: extractDocumentTabs(result, includeStructure),
    };
  }

  async createDocument(
    title: string,
    initialText?: string,
  ): Promise<DocumentResult> {
    const createUrl = new URL(DOCS_API_ROOT);
    const created = await this.request<GoogleDocument>(
      createUrl,
      'create a document',
      {
        method: 'POST',
        body: JSON.stringify({ title }),
      },
    );
    if (!created.documentId) {
      throw new GoogleApiError(
        'Google Docs created a document but did not return its ID.',
        502,
        'api_error',
      );
    }

    if (initialText) {
      await this.batchUpdate(
        created.documentId,
        [{ insertText: { location: { index: 1 }, text: initialText } }],
        created.revisionId,
        'add the initial document text',
      );
    }
    return this.getDocument(created.documentId);
  }

  private async batchUpdate(
    documentId: string,
    requests: unknown[],
    requiredRevisionId: string | undefined,
    operation: string,
  ): Promise<BatchUpdateResponse> {
    const url = new URL(
      `${DOCS_API_ROOT}/${encodeURIComponent(documentId)}:batchUpdate`,
    );
    return this.request<BatchUpdateResponse>(url, operation, {
      method: 'POST',
      body: JSON.stringify({
        requests,
        ...(requiredRevisionId ? { writeControl: { requiredRevisionId } } : {}),
      }),
    });
  }

  private async updateWithMetadata(
    document: string,
    requests: unknown[],
    requiredRevisionId: string | undefined,
    operation: string,
  ): Promise<DocumentWriteResult> {
    const documentId = parseDocumentId(document);
    const current = await this.getDocument(documentId);
    const updated = await this.batchUpdate(
      documentId,
      requests,
      requiredRevisionId,
      operation,
    );
    return {
      document_id: documentId,
      title: current.title,
      revision_id:
        updated.writeControl?.requiredRevisionId ??
        updated.writeControl?.targetRevisionId ??
        null,
      url: documentUrl(documentId),
      replies: updated.replies ?? [],
    };
  }

  async appendText(
    document: string,
    text: string,
    requiredRevisionId?: string,
    tabId?: string,
  ): Promise<DocumentWriteResult> {
    return this.updateWithMetadata(
      document,
      [
        {
          insertText: {
            endOfSegmentLocation: { ...(tabId ? { tabId } : {}) },
            text,
          },
        },
      ],
      requiredRevisionId,
      'append text',
    );
  }

  async replaceAllText(
    document: string,
    find: string,
    replacement: string,
    requiredRevisionId?: string,
    matchCase = false,
    tabIds?: string[],
  ): Promise<DocumentWriteResult> {
    return this.updateWithMetadata(
      document,
      [
        {
          replaceAllText: {
            containsText: { text: find, matchCase },
            replaceText: replacement,
            ...(tabIds?.length ? { tabsCriteria: { tabIds } } : {}),
          },
        },
      ],
      requiredRevisionId,
      'replace text',
    );
  }

  async batchUpdateDocument(
    document: string,
    requests: unknown[],
    requiredRevisionId?: string,
  ): Promise<DocumentWriteResult> {
    return this.updateWithMetadata(
      document,
      requests,
      requiredRevisionId,
      'update the document',
    );
  }
}

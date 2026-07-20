import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildDriveSearchQuery,
  escapeDriveQueryLiteral,
  extractDocumentTabs,
  GoogleApiError,
  GoogleDocsClient,
  parseDocumentId,
  type FetchLike,
} from './gdocs-client.js';

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function mockFetch(
  handler: (url: URL, init: RequestInit) => Promise<Response> | Response,
): FetchLike {
  return (async (input: string | URL | Request, init: RequestInit = {}) =>
    handler(
      new URL(input instanceof Request ? input.url : input.toString()),
      init,
    )) as FetchLike;
}

test('parseDocumentId accepts bare IDs and common Docs sharing URLs', () => {
  assert.equal(parseDocumentId('abc_123-Z'), 'abc_123-Z');
  assert.equal(
    parseDocumentId(
      'https://docs.google.com/document/d/abc_123-Z/edit?tab=t.0',
    ),
    'abc_123-Z',
  );
  assert.equal(
    parseDocumentId('https://docs.google.com/document/u/1/d/abc_123-Z/preview'),
    'abc_123-Z',
  );
  assert.throws(
    () => parseDocumentId('https://drive.google.com/file/d/abc/view'),
    /Only docs\.google\.com/,
  );
  assert.throws(() => parseDocumentId('bad id'), /invalid characters/);
});

test('Drive query literals escape quotes and backslashes', () => {
  assert.equal(escapeDriveQueryLiteral("Ian's \\ plan"), "Ian\\'s \\\\ plan");
  assert.equal(
    buildDriveSearchQuery(" Ian's \\ plan "),
    "mimeType = 'application/vnd.google-apps.document' and trashed = false and (name contains 'Ian\\'s \\\\ plan' or fullText contains 'Ian\\'s \\\\ plan')",
  );
});

test('extractDocumentTabs preserves parent/child tabs and structural text', () => {
  const tabs = extractDocumentTabs({
    title: 'Plan',
    tabs: [
      {
        tabProperties: { tabId: 'root', title: 'Overview', index: 0 },
        documentTab: {
          body: {
            content: [
              {
                paragraph: {
                  elements: [{ textRun: { content: 'Summary\n' } }],
                },
              },
              {
                table: {
                  tableRows: [
                    {
                      tableCells: [
                        {
                          content: [
                            {
                              paragraph: {
                                elements: [{ textRun: { content: 'A\n' } }],
                              },
                            },
                          ],
                        },
                        {
                          content: [
                            {
                              paragraph: {
                                elements: [{ textRun: { content: 'B\n' } }],
                              },
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              },
            ],
          },
        },
        childTabs: [
          {
            tabProperties: {
              tabId: 'child',
              title: 'Details',
              parentTabId: 'root',
              nestingLevel: 1,
            },
            documentTab: {
              body: {
                content: [
                  {
                    paragraph: {
                      elements: [{ textRun: { content: 'Child text\n' } }],
                    },
                  },
                ],
              },
            },
          },
        ],
      },
    ],
  });

  assert.deepEqual(
    tabs.map(({ tab_id, title, parent_tab_id, text }) => ({
      tab_id,
      title,
      parent_tab_id,
      text,
    })),
    [
      {
        tab_id: 'root',
        title: 'Overview',
        parent_tab_id: undefined,
        text: 'Summary\nA\tB\n',
      },
      {
        tab_id: 'child',
        title: 'Details',
        parent_tab_id: 'root',
        text: 'Child text\n',
      },
    ],
  );
});

test('searchDocuments sends an escaped read-only Drive query and pagination', async () => {
  let requestedUrl: URL | undefined;
  let requestedInit: RequestInit | undefined;
  const client = new GoogleDocsClient(
    mockFetch((url, init) => {
      requestedUrl = url;
      requestedInit = init;
      return jsonResponse({
        files: [
          {
            id: 'doc-1',
            name: 'Roadmap',
            modifiedTime: '2026-07-19T12:00:00Z',
          },
        ],
        nextPageToken: 'next-token',
      });
    }),
    'placeholder',
  );

  const result = await client.searchDocuments("Q3's plan", 25, 'page-token');

  assert.equal(requestedUrl?.hostname, 'www.googleapis.com');
  assert.equal(requestedUrl?.pathname, '/drive/v3/files');
  assert.equal(requestedUrl?.searchParams.get('pageSize'), '25');
  assert.equal(requestedUrl?.searchParams.get('pageToken'), 'page-token');
  assert.match(requestedUrl?.searchParams.get('q') ?? '', /Q3\\'s plan/);
  assert.equal(requestedInit?.method, undefined);
  assert.equal(
    new Headers(requestedInit?.headers).get('Authorization'),
    'Bearer placeholder',
  );
  assert.equal(result.next_page_token, 'next-token');
  assert.equal(
    result.documents[0].url,
    'https://docs.google.com/document/d/doc-1/edit',
  );
});

test('appendText sends tab and required revision controls atomically', async () => {
  const calls: Array<{ url: URL; init: RequestInit }> = [];
  const client = new GoogleDocsClient(
    mockFetch((url, init) => {
      calls.push({ url, init });
      if (init.method === 'POST') {
        return jsonResponse({
          replies: [{}],
          writeControl: { requiredRevisionId: 'rev-2' },
        });
      }
      return jsonResponse({
        documentId: 'doc-1',
        title: 'Roadmap',
        revisionId: 'rev-1',
        tabs: [],
      });
    }),
  );

  const result = await client.appendText(
    'doc-1',
    'New paragraph\n',
    'rev-1',
    'tab-a',
  );
  const body = JSON.parse(String(calls[1].init.body));

  assert.equal(calls[1].url.pathname, '/v1/documents/doc-1:batchUpdate');
  assert.deepEqual(body.writeControl, { requiredRevisionId: 'rev-1' });
  assert.deepEqual(body.requests, [
    {
      insertText: {
        endOfSegmentLocation: { tabId: 'tab-a' },
        text: 'New paragraph\n',
      },
    },
  ]);
  assert.equal(result.title, 'Roadmap');
  assert.equal(result.revision_id, 'rev-2');
});

test('replaceAllText limits replacement to selected tabs', async () => {
  const bodies: unknown[] = [];
  const client = new GoogleDocsClient(
    mockFetch((_url, init) => {
      if (init.method === 'POST') {
        bodies.push(JSON.parse(String(init.body)));
        return jsonResponse({ writeControl: { requiredRevisionId: 'rev-3' } });
      }
      return jsonResponse({
        documentId: 'doc-1',
        title: 'Notes',
        revisionId: 'rev-2',
      });
    }),
  );

  await client.replaceAllText('doc-1', 'draft', 'final', 'rev-2', true, [
    'tab-a',
    'tab-b',
  ]);

  assert.deepEqual(bodies[0], {
    requests: [
      {
        replaceAllText: {
          containsText: { text: 'draft', matchCase: true },
          replaceText: 'final',
          tabsCriteria: { tabIds: ['tab-a', 'tab-b'] },
        },
      },
    ],
    writeControl: { requiredRevisionId: 'rev-2' },
  });
});

test('stale revision and authentication errors are actionable and sanitized', async () => {
  const staleClient = new GoogleDocsClient(
    mockFetch((_url, init) => {
      if (init.method === 'POST') {
        return jsonResponse(
          {
            error: {
              code: 400,
              status: 'FAILED_PRECONDITION',
              message:
                'requiredRevisionId does not match; secret-token-must-not-leak',
            },
          },
          400,
        );
      }
      return jsonResponse({
        documentId: 'doc-1',
        title: 'Plan',
        revisionId: 'new',
      });
    }),
  );

  await assert.rejects(
    staleClient.appendText('doc-1', 'text', 'old'),
    (error: unknown) => {
      assert.ok(error instanceof GoogleApiError);
      assert.equal(error.kind, 'stale_revision');
      assert.match(error.message, /no changes were applied/i);
      assert.doesNotMatch(error.message, /secret-token/);
      return true;
    },
  );

  const authClient = new GoogleDocsClient(
    mockFetch(() =>
      jsonResponse(
        { error: { message: 'Bearer raw-secret-must-not-leak' } },
        401,
      ),
    ),
  );
  await assert.rejects(authClient.getDocument('doc-1'), (error: unknown) => {
    assert.ok(error instanceof GoogleApiError);
    assert.equal(error.kind, 'authentication');
    assert.match(error.message, /Reconnect Google Docs in OneCLI/);
    assert.doesNotMatch(error.message, /raw-secret/);
    return true;
  });
});

test('scope, missing-document, and network failures do not expose raw details', async () => {
  const cases = [
    {
      status: 403,
      payload: {
        error: {
          status: 'PERMISSION_DENIED',
          errors: [
            {
              reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT',
              message: 'raw-scope-secret',
            },
          ],
        },
      },
      kind: 'insufficient_scope',
      message: /lacks the OAuth scope/,
    },
    {
      status: 404,
      payload: { error: { message: 'raw-missing-secret' } },
      kind: 'not_found',
      message: /not found/,
    },
  ] as const;

  for (const entry of cases) {
    const client = new GoogleDocsClient(
      mockFetch(() => jsonResponse(entry.payload, entry.status)),
    );
    await assert.rejects(client.getDocument('doc-1'), (error: unknown) => {
      assert.ok(error instanceof GoogleApiError);
      assert.equal(error.kind, entry.kind);
      assert.match(error.message, entry.message);
      assert.doesNotMatch(error.message, /raw-|secret/);
      return true;
    });
  }

  const networkClient = new GoogleDocsClient(
    mockFetch(() => {
      throw new Error('proxy password raw-network-secret');
    }),
  );
  await assert.rejects(networkClient.getDocument('doc-1'), (error: unknown) => {
    assert.ok(error instanceof GoogleApiError);
    assert.match(error.message, /could not reach the provider through OneCLI/);
    assert.doesNotMatch(error.message, /password|raw-network-secret/);
    return true;
  });
});

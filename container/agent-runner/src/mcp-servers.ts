/**
 * Shared MCP server definitions for both agent runtimes.
 *
 * Each external tool server (calendar, Docs, github, gmail, sheets) is described once here
 * and consumed by:
 *   - the Claude path (index.ts): buildClaudeMcpServers() -> query() `mcpServers`,
 *     plus allowedMcpToolPatterns() -> `allowedTools`
 *   - the Codex path (codex-runtime.ts): buildCodexMcpConfigToml() -> config.toml
 *
 * Credential model (OneCLI gateway): servers carry `onecli-managed` placeholder
 * credentials; the gateway MITMs their HTTPS calls at each provider's API host and
 * swaps in real credentials in transit. Google OAuth-file servers additionally use
 * far-future token expiry stubs so they never attempt a client-side refresh (the
 * shared oauth2.googleapis.com token endpoint is misattributed by the gateway).
 *
 * The `nanoclaw` IPC server is NOT defined here — it needs per-message container
 * input (chat JID etc.) and is wired inline by each runtime.
 */
import fs from 'fs';

export interface McpServerDef {
  /** Server name; tools surface as mcp__<name>__* */
  name: string;
  /** Binary pre-installed in the image (see container/Dockerfile). */
  command: string;
  args: string[];
  /** Server-specific env (credential paths / placeholder tokens). */
  env: Record<string, string>;
  /**
   * Forward the OneCLI gateway proxy + CA vars. The Claude path gets these for
   * free by spreading process.env; Codex does NOT pass parent env to MCP
   * subprocesses, so it must enumerate PROXY_ENV_KEYS explicitly.
   */
  proxyEnv: boolean;
  /**
   * Preload the undici ProxyAgent dispatcher (NODE_OPTIONS --import). Needed for
   * servers that use Node's built-in fetch, which ignores proxy env vars on
   * Node 22. Harmless for servers with their own proxy handling.
   */
  nodePreload: boolean;
  /** Only register the server when this in-container file exists (creds mounted). */
  credentialCheckPath?: string;
}

export const PROXY_ENV_KEYS = [
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'https_proxy',
  'http_proxy',
  'NODE_EXTRA_CA_CERTS',
  'SSL_CERT_FILE',
  'NO_PROXY',
  'no_proxy',
] as const;

const PROXY_PRELOAD_IMPORT = '--import=file:///app/proxy-preload.mjs';

export const MCP_SERVERS: McpServerDef[] = [
  {
    // Google Calendar (@cocal/google-calendar-mcp). OAuth token files are
    // onecli-managed stubs with far-future expiry (never refreshes client-side);
    // the gateway injects at www.googleapis.com/calendar.
    name: 'gcal',
    command: 'google-calendar-mcp',
    args: [],
    env: {
      GOOGLE_OAUTH_CREDENTIALS:
        '/home/node/.config/google-calendar-mcp/gcp-oauth.keys.json',
      GOOGLE_CALENDAR_MCP_TOKEN_PATH:
        '/home/node/.config/google-calendar-mcp/tokens.json',
    },
    proxyEnv: true,
    nodePreload: true, // uses gaxios v7 / native fetch
    credentialCheckPath:
      '/home/node/.config/google-calendar-mcp/gcp-oauth.keys.json',
  },
  {
    // NanoClaw's Google Docs/Drive adapter. It sends a non-secret placeholder
    // bearer token; OneCLI replaces it for docs.googleapis.com and for the
    // adapter's read-only www.googleapis.com/drive/v3/files discovery calls.
    name: 'gdocs',
    command: 'node',
    args: ['/tmp/dist/gdocs-mcp.js'],
    env: {
      GOOGLE_API_ACCESS_TOKEN: 'placeholder',
    },
    proxyEnv: true,
    nodePreload: true,
  },
  {
    // GitHub official MCP (Go binary from github/github-mcp-server releases).
    // Token-based: the placeholder PAT is swapped by the gateway at api.github.com.
    // Go's net/http honors HTTPS_PROXY and SSL_CERT_FILE natively — no preload.
    name: 'github',
    command: 'github-mcp-server',
    args: ['stdio'],
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: 'onecli-managed',
    },
    proxyEnv: true,
    nodePreload: false,
  },
  {
    // Gmail (@gongrzhe/server-gmail-autoauth-mcp, bin `gmail-mcp`). Same stub +
    // far-future-expiry model as gcal (~/.gmail-mcp mount). Its googleapis/gaxios v6
    // stack honors HTTPS_PROXY itself; the preload is a future-proof no-op.
    name: 'gmail',
    command: 'gmail-mcp',
    args: [],
    env: {
      GMAIL_OAUTH_PATH: '/home/node/.gmail-mcp/gcp-oauth.keys.json',
      GMAIL_CREDENTIALS_PATH: '/home/node/.gmail-mcp/credentials.json',
    },
    proxyEnv: true,
    nodePreload: true,
    credentialCheckPath: '/home/node/.gmail-mcp/gcp-oauth.keys.json',
  },
  {
    // Google Sheets (google-sheets-mcp, domdomegg) via a token-refresh launcher.
    // Sheets deliberately BYPASSES the gateway: OneCLI's sheets provider can only
    // grant drive.file/drive.readonly (no full `spreadsheets` write scope), so
    // writes to existing sheets 403. The launcher refreshes a real access token
    // from the user's own OAuth creds (ro-mounted) and talks to Google directly —
    // hence proxyEnv/nodePreload are OFF on purpose.
    name: 'sheets',
    command: 'node',
    args: ['/app/sheets-mcp-launcher.mjs'],
    env: {
      SHEETS_CREDENTIALS: '/home/node/.config/nanoclaw-sheets/credentials.json',
    },
    proxyEnv: false,
    nodePreload: false,
    credentialCheckPath: '/home/node/.config/nanoclaw-sheets/credentials.json',
  },
];

/** Servers whose credentials are present in this container (or need none). */
export function activeMcpServers(): McpServerDef[] {
  return MCP_SERVERS.filter(
    (def) => !def.credentialCheckPath || fs.existsSync(def.credentialCheckPath),
  );
}

/** allowedTools patterns for the Claude runtime, e.g. "mcp__gcal__*". */
export function allowedMcpToolPatterns(): string[] {
  return activeMcpServers().map((def) => `mcp__${def.name}__*`);
}

/**
 * Claude runtime: mcpServers entries. Spreads the container env (gateway proxy +
 * CA vars reach the subprocess) and composes NODE_OPTIONS for preloading servers.
 */
export function buildClaudeMcpServers(): Record<
  string,
  {
    command: string;
    args: string[];
    env: Record<string, string | undefined>;
  }
> {
  const servers: Record<
    string,
    { command: string; args: string[]; env: Record<string, string | undefined> }
  > = {};
  for (const def of activeMcpServers()) {
    const env: Record<string, string | undefined> = {
      ...(def.proxyEnv ? process.env : {}),
      ...def.env,
    };
    if (def.nodePreload) {
      env.NODE_OPTIONS = [process.env.NODE_OPTIONS, PROXY_PRELOAD_IMPORT]
        .filter(Boolean)
        .join(' ');
    }
    servers[def.name] = { command: def.command, args: def.args, env };
  }
  return servers;
}

/** JSON.stringify doubles as a valid TOML basic-string encoder for our values. */
export function toml(value: string): string {
  return JSON.stringify(value);
}

/**
 * Codex runtime: [mcp_servers.*] TOML blocks. Codex does not forward the parent
 * env to MCP subprocesses, so proxy/CA vars are enumerated explicitly per server.
 */
export function buildCodexMcpConfigToml(): string {
  let config = '';
  for (const def of activeMcpServers()) {
    const env: Record<string, string> = { ...def.env };
    if (def.nodePreload) {
      env.NODE_OPTIONS = PROXY_PRELOAD_IMPORT;
    }
    if (def.proxyEnv) {
      for (const key of PROXY_ENV_KEYS) {
        const v = process.env[key];
        if (v) env[key] = v;
      }
    }
    config += `\n[mcp_servers.${def.name}]\n`;
    config += `command = ${toml(def.command)}\n`;
    config += `args = [${def.args.map(toml).join(', ')}]\n`;
    config += `\n[mcp_servers.${def.name}.env]\n`;
    for (const [k, v] of Object.entries(env)) {
      config += `${k} = ${toml(v)}\n`;
    }
  }
  return config;
}

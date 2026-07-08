// Launcher for the Google Sheets MCP server — refreshes a REAL access token, then
// execs the server. Sheets is the one service that bypasses the OneCLI gateway:
// the gateway's sheets provider can only grant drive.file/drive.readonly (no full
// `spreadsheets` write scope), so writes to existing sheets 403. Instead, this
// launcher uses the user's own OAuth client + refresh token (full spreadsheets
// scope) from a read-only mounted credentials file, and talks to Google directly.
//
// IMPORTANT: this process is intentionally started WITHOUT proxy env vars (see the
// sheets descriptor in src/mcp-servers.ts) — the token refresh must NOT ride the
// gateway, whose shared oauth2.googleapis.com handling is misattributed to another
// provider. Direct HTTPS with system CAs is correct here.
//
// The refreshed access token lives ~60 min; containers idle out at 30 min, so one
// refresh per spawn suffices.
import fs from 'fs';
import { spawn } from 'child_process';

const credsPath =
  process.env.SHEETS_CREDENTIALS ||
  '/home/node/.config/nanoclaw-sheets/credentials.json';

let creds;
try {
  creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
} catch (err) {
  console.error(`[sheets-launcher] cannot read ${credsPath}: ${err.message}`);
  process.exit(1);
}

for (const k of ['client_id', 'client_secret', 'refresh_token']) {
  if (!creds[k]) {
    console.error(`[sheets-launcher] ${credsPath} missing "${k}"`);
    process.exit(1);
  }
}

const resp = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
  }),
});

if (!resp.ok) {
  const body = await resp.text().catch(() => '');
  console.error(
    `[sheets-launcher] token refresh failed (${resp.status}): ${body.slice(0, 300)}. ` +
      'If this says invalid_grant, the refresh token likely expired — re-run ' +
      'scripts/sheets-oauth-setup.mjs on the host (and ensure the OAuth consent ' +
      'screen is published to Production, not Testing).',
  );
  process.exit(1);
}

const { access_token } = await resp.json();
if (!access_token) {
  console.error('[sheets-launcher] token response had no access_token');
  process.exit(1);
}

// Exec the MCP server with the fresh token; stdio passes straight through so the
// MCP client sees this launcher as the server itself.
const child = spawn('google-sheets-mcp', [], {
  stdio: 'inherit',
  env: { ...process.env, GOOGLE_ACCESS_TOKEN: access_token },
});
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
child.on('error', (err) => {
  console.error(`[sheets-launcher] failed to start google-sheets-mcp: ${err.message}`);
  process.exit(1);
});

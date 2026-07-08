#!/usr/bin/env node
// One-time Google Sheets OAuth setup for NanoClaw.
//
// Mints a long-lived refresh token with the FULL `spreadsheets` scope using your own
// Google OAuth client, and writes ~/.config/nanoclaw-sheets/credentials.json — the
// file the container's sheets MCP launcher uses to talk to Google directly (the
// OneCLI gateway's sheets provider cannot grant write access to existing sheets).
//
// Prerequisites (Google Cloud console, https://console.cloud.google.com):
//   1. OAuth consent screen: PUBLISH the app to "In production" (Testing-mode
//      refresh tokens expire after 7 days). Unverified is fine for personal use.
//   2. Your OAuth client (APIs & Services -> Credentials): add this exact
//      Authorized redirect URI:  http://localhost:8766/callback
//   3. Enable the Google Sheets API if you haven't (APIs & Services -> Library).
//
// Run on the host:   node scripts/sheets-oauth-setup.mjs
// If you're remote, tunnel the callback port first:
//   ssh -L 8766:localhost:8766 <user>@<host>
// then open the printed URL in your local browser and sign in.
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import readline from 'readline/promises';

const PORT = 8766;
const REDIRECT_URI = `http://localhost:${PORT}/callback`;
const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const OUT_DIR = path.join(os.homedir(), '.config', 'nanoclaw-sheets');
const OUT_FILE = path.join(OUT_DIR, 'credentials.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const clientId =
  process.env.GOOGLE_CLIENT_ID || (await rl.question('OAuth Client ID: ')).trim();
const clientSecret =
  process.env.GOOGLE_CLIENT_SECRET ||
  (await rl.question('OAuth Client Secret: ')).trim();
rl.close();

if (!clientId || !clientSecret) {
  console.error('Client ID and secret are required.');
  process.exit(1);
}

const authUrl =
  'https://accounts.google.com/o/oauth2/v2/auth?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline', // -> refresh token
    prompt: 'consent', // force a refresh token even if previously authorized
  }).toString();

console.log('\nOpen this URL in your browser and sign in as the Google account');
console.log('whose sheets the agent should edit:\n');
console.log(`  ${authUrl}\n`);
console.log(`Waiting for the OAuth callback on ${REDIRECT_URI} ...`);

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const err = url.searchParams.get('error');
    const c = url.searchParams.get('code');
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      err
        ? `<h2>Authorization failed: ${err}</h2>`
        : '<h2>Authorized — you can close this tab and return to the terminal.</h2>',
    );
    server.close();
    if (err) reject(new Error(`OAuth error: ${err}`));
    else resolve(c);
  });
  server.listen(PORT, '127.0.0.1');
  server.on('error', reject);
});

const resp = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT_URI,
  }),
});
if (!resp.ok) {
  console.error(`Token exchange failed (${resp.status}): ${await resp.text()}`);
  process.exit(1);
}
const tokens = await resp.json();
if (!tokens.refresh_token) {
  console.error(
    'No refresh_token in response. Remove prior grants at ' +
      'https://myaccount.google.com/permissions and re-run.',
  );
  process.exit(1);
}

fs.mkdirSync(OUT_DIR, { recursive: true, mode: 0o700 });
fs.writeFileSync(
  OUT_FILE,
  JSON.stringify(
    {
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: tokens.refresh_token,
      scope: SCOPE,
    },
    null,
    2,
  ) + '\n',
  { mode: 0o600 },
);
console.log(`\nSaved ${OUT_FILE}`);
console.log('Done. The agent picks this up on its next message (no restart needed).');

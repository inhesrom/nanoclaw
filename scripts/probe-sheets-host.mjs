#!/usr/bin/env node
// Probe the host-side Google Sheets refresh token (NOT OneCLI).
// Talks to oauth2.googleapis.com / sheets.googleapis.com directly — do not run
// this through the OneCLI gateway (shared token endpoint is misattributed).
//
// Prints one TSV line: name<TAB>code<TAB>snippet
//   200 — refresh succeeded (Sheets API accepted the token, or returned 403/404)
//   401 — invalid_grant / API 401
//   000 — missing file, malformed creds, or network error
import fs from 'fs';
import os from 'os';
import path from 'path';

const NAME = 'sheets-host';
const credsPath =
  process.env.SHEETS_CREDENTIALS ||
  path.join(os.homedir(), '.config', 'nanoclaw-sheets', 'credentials.json');

function emit(code, snippet) {
  const safe = String(snippet).replace(/[\t\n\r"]/g, ' ').slice(0, 240);
  process.stdout.write(`${NAME}\t${code}\t${safe}\n`);
}

if (!fs.existsSync(credsPath)) {
  emit('000', 'missing credentials file');
  process.exit(0);
}

let creds;
try {
  creds = JSON.parse(fs.readFileSync(credsPath, 'utf8'));
} catch (err) {
  emit('000', `cannot read credentials: ${err.message}`);
  process.exit(0);
}

for (const k of ['client_id', 'client_secret', 'refresh_token']) {
  if (!creds[k]) {
    emit('000', `credentials missing ${k}`);
    process.exit(0);
  }
}

const refresh = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: creds.client_id,
    client_secret: creds.client_secret,
    refresh_token: creds.refresh_token,
  }),
});
const refreshBody = await refresh.text();
if (!refresh.ok) {
  const code = /invalid_grant/i.test(refreshBody) ? '401' : String(refresh.status);
  emit(code, refreshBody.slice(0, 240));
  process.exit(0);
}

let accessToken;
try {
  accessToken = JSON.parse(refreshBody).access_token;
} catch {
  emit('000', 'refresh response was not JSON');
  process.exit(0);
}
if (!accessToken) {
  emit('000', 'refresh response had no access_token');
  process.exit(0);
}

const probe = await fetch(
  'https://sheets.googleapis.com/v4/spreadsheets/1invalidprobeid',
  { headers: { Authorization: `Bearer ${accessToken}` } },
);
const probeBody = (await probe.text()).slice(0, 240);
// 200 unexpected, 403/404 mean Google accepted the bearer token.
if (probe.status === 401) {
  emit('401', probeBody);
  process.exit(0);
}
if (probe.status === 0) {
  emit('000', probeBody || 'sheets API unreachable');
  process.exit(0);
}
emit('200', `refresh ok; sheets API HTTP ${probe.status}`);

import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetGoogleAuthMonitorForTests,
  diffAuthSnapshots,
  formatAuthAlert,
  parseAuthProbeJson,
  pollGoogleAuthOnce,
  type AuthSnapshot,
} from './google-auth-monitor.js';

function snapshot(
  services: AuthSnapshot['services'],
  hint?: string,
): AuthSnapshot {
  return { checkedAt: '2026-08-15T18:00:00.000Z', services, hint };
}

describe('google auth monitor', () => {
  afterEach(() => {
    _resetGoogleAuthMonitorForTests();
  });

  it('parses --json output including onecli preamble', () => {
    const raw = [
      'onecli: gateway connected. Starting bash...',
      '{"wakeAgent":true,"data":{"ok":false,"services":{"calendar":{"ok":true,"httpStatus":200},"sheets-host":{"ok":false,"httpStatus":401}},"failures":[{"service":"sheets-host","httpStatus":401}],"hint":"re-run setup"}}',
    ].join('\n');
    const parsed = parseAuthProbeJson(raw);
    expect(parsed.services.calendar).toEqual({ ok: true, httpStatus: 200 });
    expect(parsed.services['sheets-host']).toEqual({
      ok: false,
      httpStatus: 401,
    });
    expect(parsed.hint).toBe('re-run setup');
  });

  it('treats first-seen failures as down and later recoveries as recovered', () => {
    const first = diffAuthSnapshots(
      null,
      snapshot({
        calendar: { ok: true, httpStatus: 200 },
        'sheets-host': { ok: false, httpStatus: 401 },
      }),
    );
    expect(first.down).toEqual(['sheets-host']);
    expect(first.recovered).toEqual([]);

    const recovered = diffAuthSnapshots(
      snapshot({
        calendar: { ok: true, httpStatus: 200 },
        'sheets-host': { ok: false, httpStatus: 401 },
      }),
      snapshot({
        calendar: { ok: true, httpStatus: 200 },
        'sheets-host': { ok: true, httpStatus: 200 },
      }),
    );
    expect(recovered.down).toEqual([]);
    expect(recovered.recovered).toEqual(['sheets-host']);

    const unchanged = diffAuthSnapshots(
      snapshot({
        'sheets-host': { ok: false, httpStatus: 401 },
      }),
      snapshot({
        'sheets-host': { ok: false, httpStatus: 401 },
      }),
    );
    expect(unchanged.down).toEqual([]);
    expect(unchanged.recovered).toEqual([]);
  });

  it('formats a WhatsApp alert with remaining healthy services', () => {
    const text = formatAuthAlert(
      { down: ['sheets-host'], recovered: [] },
      snapshot(
        {
          calendar: { ok: true, httpStatus: 200 },
          'sheets-host': { ok: false, httpStatus: 401 },
        },
        'Re-run node scripts/sheets-oauth-setup.mjs',
      ),
    );
    expect(text).toContain('*Google services down*');
    expect(text).toContain('• *sheets-host* (HTTP 401)');
    expect(text).toContain('Still ok: calendar');
    expect(text).toContain('Re-run node scripts/sheets-oauth-setup.mjs');
  });

  it('sends WhatsApp only on transitions and persists state across polls', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-auth-'));
    const statePath = path.join(dir, 'status.json');
    const sent: string[] = [];
    let current = snapshot({
      calendar: { ok: true, httpStatus: 200 },
      'sheets-host': { ok: false, httpStatus: 401 },
    });

    const deps = {
      sendMessage: async (_jid: string, text: string) => {
        sent.push(text);
      },
      getAlertJid: () => '17193224564@s.whatsapp.net',
      runProbe: async () => current,
      statePath,
    };

    const first = await pollGoogleAuthOnce(deps);
    expect(first?.down).toEqual(['sheets-host']);
    expect(sent).toHaveLength(1);

    const second = await pollGoogleAuthOnce(deps);
    expect(second?.down).toEqual([]);
    expect(sent).toHaveLength(1);

    current = snapshot({
      calendar: { ok: true, httpStatus: 200 },
      'sheets-host': { ok: true, httpStatus: 200 },
    });
    const third = await pollGoogleAuthOnce(deps);
    expect(third?.recovered).toEqual(['sheets-host']);
    expect(sent).toHaveLength(2);
    expect(sent[1]).toContain('*Google services recovered*');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

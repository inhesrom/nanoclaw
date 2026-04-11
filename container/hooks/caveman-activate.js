#!/usr/bin/env node
// caveman — Claude Code SessionStart activation hook
//
// Runs on every session start:
//   1. Writes flag file at ~/.claude/.caveman-active (statusline reads this)
//   2. Emits caveman ruleset as hidden SessionStart context

const fs = require('fs');
const path = require('path');
const os = require('os');
const { getDefaultMode } = require('./caveman-config');

const claudeDir = path.join(os.homedir(), '.claude');
const flagPath = path.join(claudeDir, '.caveman-active');
const settingsPath = path.join(claudeDir, 'settings.json');

const mode = getDefaultMode();

// "off" mode — skip activation entirely
if (mode === 'off') {
  try { fs.unlinkSync(flagPath); } catch (e) {}
  process.stdout.write('OK');
  process.exit(0);
}

// 1. Write flag file
try {
  fs.mkdirSync(path.dirname(flagPath), { recursive: true });
  fs.writeFileSync(flagPath, mode);
} catch (e) {
  // Silent fail — flag is best-effort
}

// 2. Emit full caveman ruleset, filtered to the active intensity level.
const INDEPENDENT_MODES = new Set(['commit', 'review', 'compress']);

if (INDEPENDENT_MODES.has(mode)) {
  process.stdout.write('CAVEMAN MODE ACTIVE — level: ' + mode + '. Behavior defined by /caveman-' + mode + ' skill.');
  process.exit(0);
}

const modeLabel = mode === 'wenyan' ? 'wenyan-full' : mode;

// Read SKILL.md — single source of truth for caveman behavior.
// __dirname = ~/.claude/hooks/, SKILL.md at ~/.claude/skills/caveman/SKILL.md
let skillContent = '';
try {
  skillContent = fs.readFileSync(
    path.join(__dirname, '..', 'skills', 'caveman', 'SKILL.md'), 'utf8'
  );
} catch (e) { /* will use fallback below */ }

let output;

if (skillContent) {
  const body = skillContent.replace(/^---[\s\S]*?---\s*/, '');

  const filtered = body.split('\n').reduce((acc, line) => {
    const tableRowMatch = line.match(/^\|\s*\*\*(\S+?)\*\*\s*\|/);
    if (tableRowMatch) {
      if (tableRowMatch[1] === modeLabel) acc.push(line);
      return acc;
    }
    const exampleMatch = line.match(/^- (\S+?):\s/);
    if (exampleMatch) {
      if (exampleMatch[1] === modeLabel) acc.push(line);
      return acc;
    }
    acc.push(line);
    return acc;
  }, []);

  output = 'CAVEMAN MODE ACTIVE — level: ' + modeLabel + '\n\n' + filtered.join('\n');
} else {
  output =
    'CAVEMAN MODE ACTIVE — level: ' + modeLabel + '\n\n' +
    'Respond terse like smart caveman. All technical substance stay. Only fluff die.\n\n' +
    'ACTIVE EVERY RESPONSE. Off only: "stop caveman" / "normal mode".\n\n' +
    'Drop: articles (a/an/the), filler, pleasantries, hedging. Fragments OK. Technical terms exact. Code blocks unchanged.\n\n' +
    'Pattern: `[thing] [action] [reason]. [next step].`';
}

process.stdout.write(output);

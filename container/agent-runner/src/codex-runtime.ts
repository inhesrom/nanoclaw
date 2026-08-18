/**
 * Codex runtime for the NanoClaw agent container.
 *
 * Alternative to the Claude Agent SDK path in index.ts, selected when
 * NANOCLAW_RUNTIME=codex. Drives the OpenAI Codex CLI (`codex exec --json`) one
 * turn per message, resuming the same Codex session for follow-ups. It reuses the
 * provider-neutral IPC/output primitives from index.ts (passed in as `deps`) so the
 * host sees the identical OUTPUT_START/END marker protocol.
 *
 * Codex event schema (codex exec --json), verified against codex-cli 0.142.5:
 *   {"type":"thread.started","thread_id":"<session id>"}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{...}}
 */
import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import { buildCodexMcpConfigToml, toml } from './mcp-servers.js';

interface ContainerOutput {
  status: 'success' | 'error';
  result: string | null;
  newSessionId?: string;
  error?: string;
}

export interface CodexDeps {
  writeOutput: (output: ContainerOutput) => void;
  waitForIpcMessage: () => Promise<string | null>;
  log: (message: string) => void;
}

interface CodexContainerInput {
  chatJid: string;
  groupFolder: string;
  isMain: boolean;
  agentSettings?: RuntimeAgentSettings;
}

interface RuntimeAgentSettings {
  model?: string;
  reasoningEffort?: string;
}

const CODEX_HOME = process.env.CODEX_HOME || '/home/node/.codex';
const WORKDIR = '/workspace/group';
/** Matches `[Image: attachments/…]` markers written by the host media pipeline. */
const IMAGE_REF_PATTERN = /\[Image: (attachments\/[^\]]+)\]/g;
const CODEX_REASONING_EFFORTS = [
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const;
type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];

/** Prefer `.vision.jpg` sidecar when present. */
function resolveVisionAbsolutePath(relativePath: string): string {
  const dir = path.dirname(relativePath);
  const base = path.basename(relativePath, path.extname(relativePath));
  const visionRel = path.join(dir, `${base}.vision.jpg`);
  const visionAbs = path.join(WORKDIR, visionRel);
  if (fs.existsSync(visionAbs)) return visionAbs;
  return path.join(WORKDIR, relativePath);
}

/**
 * Build `codex exec -i <file>` args from `[Image: …]` markers in the prompt.
 * Works for both fresh exec and `exec resume` (Codex accepts -i on resume).
 */
export function imageArgsFromPrompt(prompt: string): string[] {
  const args: string[] = [];
  const seen = new Set<string>();
  IMAGE_REF_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = IMAGE_REF_PATTERN.exec(prompt)) !== null) {
    const rel = match[1];
    if (seen.has(rel)) continue;
    seen.add(rel);
    const abs = resolveVisionAbsolutePath(rel);
    if (fs.existsSync(abs)) {
      args.push('-i', abs);
    }
  }
  return args;
}

function isCodexReasoningEffort(
  effort: string | undefined,
): effort is CodexReasoningEffort {
  return CODEX_REASONING_EFFORTS.includes(effort as CodexReasoningEffort);
}

const CODEX_STDERR_NOISE =
  /UNDICI-EHPA|trace-warnings|Reading additional input from stdin/i;

export function redactCodexDetail(text: string): string {
  return text
    .replace(/(https?:\/\/[^:\s]+:)[^@\s]+@/gi, '$1[REDACTED]@')
    .replace(/\baoc_[A-Za-z0-9]+\b/g, 'aoc_[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9-]+\b/g, 'sk-[REDACTED]');
}

export function extractCodexJsonError(event: {
  type?: string;
  message?: string;
  error?: { message?: string } | string;
}): string | undefined {
  if (event.type !== 'error' && event.type !== 'turn.failed') return undefined;
  if (typeof event.message === 'string' && event.message.trim()) {
    return event.message.trim();
  }
  if (typeof event.error === 'string' && event.error.trim()) {
    return event.error.trim();
  }
  if (
    event.error &&
    typeof event.error === 'object' &&
    typeof event.error.message === 'string' &&
    event.error.message.trim()
  ) {
    return event.error.message.trim();
  }
  return undefined;
}

export function formatCodexExitError(
  code: number | null,
  stderr: string,
  jsonError?: string,
): string {
  const prefix = `codex exited with code ${code}`;
  const fromJson = jsonError?.trim();
  if (fromJson) return redactCodexDetail(`${prefix}: ${fromJson}`);

  const useful = stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !CODEX_STDERR_NOISE.test(line));
  if (useful.length === 0) return prefix;
  return redactCodexDetail(`${prefix}: ${useful.join(' ').slice(0, 400)}`);
}

function codexSettingArgs(
  settings: RuntimeAgentSettings | undefined,
): string[] {
  const args: string[] = [];
  if (settings?.model) {
    args.push('--model', settings.model);
  }
  if (isCodexReasoningEffort(settings?.reasoningEffort)) {
    args.push(
      '--config',
      `model_reasoning_effort=${toml(settings.reasoningEffort)}`,
    );
  }
  return args;
}

/**
 * Write ~/.codex/config.toml wiring the same stdio MCP servers the Claude path
 * uses, and disabling Codex's own sandbox/approvals (the container already isolates).
 * External tool servers (gcal, gdocs, github, gmail, sheets) come from the shared
 * definitions in mcp-servers.ts; Codex does NOT pass the parent env to MCP
 * subprocesses, so the builder enumerates the gateway proxy/CA vars explicitly.
 */
function writeCodexConfig(
  mcpServerPath: string,
  input: CodexContainerInput,
): void {
  fs.mkdirSync(CODEX_HOME, { recursive: true });
  let config = `# Generated by NanoClaw agent-runner (codex runtime) — regenerated each spawn.
approval_policy = "never"
sandbox_mode = "danger-full-access"
`;

  if (input.agentSettings?.model) {
    config += `model = ${toml(input.agentSettings.model)}\n`;
  }
  if (isCodexReasoningEffort(input.agentSettings?.reasoningEffort)) {
    config += `model_reasoning_effort = ${toml(input.agentSettings.reasoningEffort)}\n`;
  }

  config += `

[mcp_servers.nanoclaw]
command = "node"
args = [${toml(mcpServerPath)}]

[mcp_servers.nanoclaw.env]
NANOCLAW_CHAT_JID = ${toml(input.chatJid)}
NANOCLAW_GROUP_FOLDER = ${toml(input.groupFolder)}
NANOCLAW_IS_MAIN = ${toml(input.isMain ? '1' : '0')}
`;

  config += buildCodexMcpConfigToml();

  fs.writeFileSync(path.join(CODEX_HOME, 'config.toml'), config);
}

/**
 * Codex reads AGENTS.md (not CLAUDE.md). Surface the group's memory by symlinking
 * AGENTS.md -> CLAUDE.md in the workspace so `codex` picks it up from cwd.
 */
function surfaceGroupMemory(deps: CodexDeps): void {
  const claudeMd = path.join(WORKDIR, 'CLAUDE.md');
  const agentsMd = path.join(WORKDIR, 'AGENTS.md');
  if (!fs.existsSync(claudeMd) || fs.existsSync(agentsMd)) return;
  try {
    fs.symlinkSync('CLAUDE.md', agentsMd);
  } catch (err) {
    // Fall back to a copy if symlinks aren't permitted on the mount.
    try {
      fs.copyFileSync(claudeMd, agentsMd);
    } catch {
      deps.log(
        `Could not surface CLAUDE.md as AGENTS.md: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

interface CodexTurnResult {
  sessionId?: string;
  result: string | null;
}

/** Run one `codex exec` (or `codex exec resume`) turn and parse its JSONL stream. */
function runCodexTurn(
  prompt: string,
  sessionId: string | undefined,
  agentSettings: RuntimeAgentSettings | undefined,
  deps: CodexDeps,
): Promise<CodexTurnResult> {
  return new Promise((resolve, reject) => {
    // `codex exec resume` rejects --sandbox (it inherits sandbox from config.toml's
    // sandbox_mode); only a fresh `codex exec` accepts the flag.
    // Both fresh and resume accept -i/--image for vision.
    const imageArgs = imageArgsFromPrompt(prompt);
    if (imageArgs.length > 0) {
      deps.log(
        `Attaching ${imageArgs.length / 2} image(s) to codex turn via -i`,
      );
    }
    const base = [
      '--json',
      '--skip-git-repo-check',
      ...codexSettingArgs(agentSettings),
      ...imageArgs,
    ];
    // Keep sessionId before flags (existing working order); Codex accepts -i
    // both on fresh exec and resume.
    const args = sessionId
      ? ['exec', 'resume', sessionId, ...base, prompt]
      : ['exec', ...base, '--sandbox', 'danger-full-access', prompt];

    // stdin 'ignore' → immediate EOF, so codex doesn't hang "Reading additional
    // input from stdin...". Inherit env (proxy/CA vars + CODEX_HOME).
    const child = spawn('codex', args, {
      cwd: WORKDIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    let buf = '';
    let stderr = '';
    let newSessionId: string | undefined;
    const agentMessages: string[] = [];
    let turnCompleted = false;
    let jsonError: string | undefined;

    const handleLine = (line: string): void => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev: {
        type?: string;
        thread_id?: string;
        message?: string;
        error?: { message?: string } | string;
        item?: { type?: string; text?: string };
      };
      try {
        ev = JSON.parse(trimmed);
      } catch {
        return; // non-JSON line (banner/warning)
      }
      const parsedError = extractCodexJsonError(ev);
      if (parsedError) jsonError = parsedError;
      if (ev.type === 'thread.started' && ev.thread_id) {
        newSessionId = ev.thread_id;
      } else if (
        ev.type === 'item.completed' &&
        ev.item?.type === 'agent_message' &&
        typeof ev.item.text === 'string'
      ) {
        agentMessages.push(ev.item.text);
      } else if (ev.type === 'turn.completed') {
        turnCompleted = true;
      }
    };

    child.stdout.on('data', (d: Buffer) => {
      buf += d.toString();
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        handleLine(buf.slice(0, idx));
        buf = buf.slice(idx + 1);
      }
    });
    child.stderr.on('data', (d: Buffer) => {
      const s = d.toString();
      stderr += s;
      const trimmed = s.trim();
      if (trimmed) deps.log(`[codex] ${trimmed.slice(0, 300)}`);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      if (buf) handleLine(buf); // flush any trailing partial line
      // The last agent_message is the user-facing reply.
      const result = agentMessages.length
        ? agentMessages[agentMessages.length - 1]
        : null;
      if (code !== 0 && !turnCompleted) {
        reject(new Error(formatCodexExitError(code, stderr, jsonError)));
        return;
      }
      resolve({ sessionId: newSessionId, result });
    });
  });
}

/**
 * Codex equivalent of the Claude query loop: one turn per message, resuming the
 * session for follow-ups, blocking on IPC between turns. Emits results via the
 * shared writeOutput markers so the host handles them identically to the Claude path.
 */
export async function runCodexLoop(
  initialPrompt: string,
  initialSessionId: string | undefined,
  containerInput: CodexContainerInput,
  mcpServerPath: string,
  deps: CodexDeps,
): Promise<void> {
  writeCodexConfig(mcpServerPath, containerInput);
  surfaceGroupMemory(deps);

  let sessionId = initialSessionId;
  let prompt = initialPrompt;

  while (true) {
    deps.log(`Codex turn (session: ${sessionId || 'new'})`);
    let turn: CodexTurnResult;
    try {
      turn = await runCodexTurn(
        prompt,
        sessionId,
        containerInput.agentSettings,
        deps,
      );
    } catch (err) {
      // A stale session id from a previous container can't resume — start fresh once.
      if (sessionId) {
        deps.log(
          `Codex resume failed (${err instanceof Error ? err.message : String(err)}); starting a fresh session`,
        );
        sessionId = undefined;
        turn = await runCodexTurn(
          prompt,
          undefined,
          containerInput.agentSettings,
          deps,
        );
      } else {
        throw err;
      }
    }

    if (turn.sessionId) sessionId = turn.sessionId;
    deps.log(
      `Codex turn done (session: ${sessionId || 'none'}, result: ${turn.result ? `${turn.result.slice(0, 120)}` : 'none'})`,
    );

    // Emit the reply, then a null session-update (mirrors the Claude outer loop:
    // keeps the host's session tracking + idle timer consistent).
    deps.writeOutput({
      status: 'success',
      result: turn.result,
      newSessionId: sessionId,
    });
    deps.writeOutput({
      status: 'success',
      result: null,
      newSessionId: sessionId,
    });

    const next = await deps.waitForIpcMessage();
    if (next === null) {
      deps.log('Close sentinel received, exiting codex loop');
      break;
    }
    prompt = next;
  }
}

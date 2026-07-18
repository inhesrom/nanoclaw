import {
  conversationEntries,
  type AppState,
  type ConfirmationDecision,
} from './state';

export interface CompanionActions {
  onPair(code: string): Promise<void>;
  onRetry(): Promise<void>;
  onNewTurn(): Promise<void>;
  onConfirm(decision: ConfirmationDecision): Promise<void>;
}

export interface CompanionUi {
  render(state: AppState): void;
}

const labels: Record<AppState['kind'], string> = {
  booting: 'Connecting',
  pairing: 'Pairing required',
  ready: 'Ready',
  recording: 'Listening',
  stopping: 'Transcribing',
  uploading: 'Transcribing',
  transcribing: 'Transcribing',
  review: 'Review draft',
  thinking: 'Thinking',
  error: 'Needs attention',
};

export function mountCompanionUi(actions: CompanionActions): CompanionUi {
  const root = document.querySelector<HTMLDivElement>('#app');
  if (!root) throw new Error('Companion root is missing');
  root.innerHTML = `${styles}
    <div class="lens">
      <header id="connection" class="connection"></header>
      <div class="ledger-wrap">
        <div class="rail" aria-hidden="true"></div>
        <section id="ledger" class="ledger" aria-label="Conversation feed"></section>
        <button id="latest" class="latest" data-action="latest" hidden>Latest ↓</button>
      </div>
      <footer id="dock" class="dock" aria-live="polite"></footer>
    </div>`;

  const connection = root.querySelector<HTMLElement>('#connection')!;
  const ledger = root.querySelector<HTMLElement>('#ledger')!;
  const dock = root.querySelector<HTMLElement>('#dock')!;
  const latest = root.querySelector<HTMLButtonElement>('#latest')!;
  let reviewingHistory = false;

  ledger.addEventListener('scroll', () => {
    reviewingHistory =
      ledger.scrollHeight - ledger.scrollTop - ledger.clientHeight > 24;
    latest.hidden = !reviewingHistory;
  });
  root.addEventListener('submit', (event) => {
    const form = event.target as HTMLFormElement;
    if (form.id !== 'pairForm') return;
    event.preventDefault();
    const input = form.elements.namedItem('code') as HTMLInputElement;
    const button = form.querySelector<HTMLButtonElement>('button')!;
    button.disabled = true;
    void actions
      .onPair(input.value)
      .catch(() => undefined)
      .finally(() => {
        button.disabled = false;
      });
  });
  root.addEventListener('click', (event) => {
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>(
      'button[data-action]',
    )?.dataset.action;
    if (action === 'retry') void actions.onRetry().catch(() => undefined);
    if (action === 'new') void actions.onNewTurn().catch(() => undefined);
    if (action === 'send') {
      void actions.onConfirm('send').catch(() => undefined);
    }
    if (action === 'discard') {
      void actions.onConfirm('discard').catch(() => undefined);
    }
    if (action === 'latest') {
      reviewingHistory = false;
      ledger.scrollTop = ledger.scrollHeight;
      latest.hidden = true;
    }
  });

  return {
    render(state) {
      const priorScrollTop = ledger.scrollTop;
      connection.innerHTML = renderConnection(state);
      ledger.innerHTML = renderLedger(state);
      dock.innerHTML = renderDock(state);
      if (reviewingHistory) {
        ledger.scrollTop = priorScrollTop;
        latest.hidden = false;
      } else {
        ledger.scrollTop = ledger.scrollHeight;
        latest.hidden = true;
      }
    },
  };
}

export function renderCompanionState(state: AppState): string {
  return `${renderConnection(state)}${renderLedger(state)}${renderDock(state)}`;
}

function renderConnection(state: AppState): string {
  if (state.kind === 'pairing') {
    return `<div>
      <p class="brand">NanoClaw <span>/ G2</span></p>
      <p class="connection-state">Pairing required</p>
    </div>
    <form id="pairForm" class="pair-form">
      <label for="pairCode">Host pairing code</label>
      <input id="pairCode" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required />
      <button type="submit">Pair</button>
      ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ''}
    </form>`;
  }
  return `<div>
    <p class="brand">NanoClaw <span>/ G2</span></p>
    <p class="connection-state"><i aria-hidden="true"></i> Private host connected</p>
  </div>
  <p class="phase">${escapeHtml(labels[state.kind])}</p>`;
}

function renderLedger(state: AppState): string {
  const entries = conversationEntries(state);
  if (entries.length === 0) {
    return `<div class="empty">
      <p>Conversation ledger</p>
      <strong>${state.kind === 'pairing' ? 'Pair to begin.' : 'Tap your G2 to speak.'}</strong>
    </div>`;
  }
  return entries
    .map(
      (entry) => `<article class="signal signal-${entry.speaker.toLowerCase()}">
        <span class="signal-dot" aria-hidden="true"></span>
        <p class="speaker">${entry.speaker}</p>
        <p class="utterance">${escapeHtml(entry.text)}</p>
      </article>`,
    )
    .join('');
}

function renderDock(state: AppState): string {
  const status = `<div><p class="dock-label">Status</p><p class="dock-status">${escapeHtml(
    statusText(state),
  )}</p></div>`;
  if (state.kind === 'review') {
    return `${status}<div class="dock-actions">
      <button data-action="send">Send</button>
      <button class="secondary" data-action="discard">Try again</button>
    </div>`;
  }
  if (state.kind === 'error') {
    return `${status}<div class="dock-actions">${
      state.retryable
        ? '<button data-action="retry">Retry</button>'
        : '<button class="secondary" data-action="new">Return</button>'
    }</div>`;
  }
  return status;
}

function statusText(state: AppState): string {
  switch (state.kind) {
    case 'booting':
      return 'Opening the private Tailscale link…';
    case 'pairing':
      return 'Run npm run evenhub:pair on the host.';
    case 'ready':
      return 'Tap to record.';
    case 'recording':
      return `Listening · ${(state.bytes / 32_000).toFixed(1)}s · Tap to stop`;
    case 'stopping':
    case 'uploading':
    case 'transcribing':
      return state.kind === 'transcribing' && state.notice
        ? state.notice
        : 'Transcribing…';
    case 'review':
      return state.notice || 'Draft is waiting. Nothing has been sent.';
    case 'thinking':
      return state.notice || 'NanoClaw is thinking…';
    case 'error':
      return state.message;
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!,
  );
}

const styles = `<style>
  :root {
    color: #e8eee9;
    background: #080c0b;
    font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    font-synthesis: none;
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-width: 280px; min-height: 100vh; background: radial-gradient(circle at 70% -10%, #26342f 0, #111816 36%, #080c0b 72%); }
  button, input { font: inherit; }
  .lens { min-height: 100vh; max-width: 760px; margin: 0 auto; display: grid; grid-template-rows: auto minmax(0, 1fr) auto; }
  .connection { min-height: 76px; padding: 18px clamp(20px, 5vw, 42px); border-bottom: 1px solid #33413b; display: flex; align-items: center; justify-content: space-between; gap: 20px; background: rgba(8, 12, 11, .72); backdrop-filter: blur(14px); }
  .brand, .connection-state, .phase, .speaker, .utterance, .dock-label, .dock-status, .empty p, .empty strong { margin: 0; }
  .brand { color: #f4f7f4; font-weight: 760; letter-spacing: -.02em; }
  .brand span, .phase { color: #82938b; }
  .connection-state, .phase { margin-top: 5px; font: 650 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .05em; text-transform: uppercase; }
  .connection-state i { display: inline-block; width: 6px; height: 6px; margin-right: 6px; border-radius: 50%; background: #9ee8c7; box-shadow: 0 0 12px #74cfa7; }
  .ledger-wrap { min-height: 0; position: relative; display: grid; grid-template-columns: 44px 1fr; padding: 0 clamp(20px, 5vw, 42px); }
  .rail { border-right: 1px solid #34423c; }
  .ledger { min-height: 220px; max-height: calc(100vh - 176px); overflow-y: auto; padding: 28px 0 72px 26px; scroll-behavior: smooth; overscroll-behavior: contain; }
  .signal { position: relative; padding: 0 0 30px; }
  .signal-dot { position: absolute; left: -31px; top: 4px; width: 9px; height: 9px; border: 2px solid #111816; border-radius: 50%; background: #7f948a; box-shadow: 0 0 0 1px #52645c; }
  .signal-nanoclaw .signal-dot { background: #b6f29d; box-shadow: 0 0 16px rgba(182, 242, 157, .4); }
  .signal-notice .signal-dot { background: #ff9a8d; }
  .speaker { color: #8fd2bd; font: 750 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .11em; text-transform: uppercase; }
  .utterance { margin-top: 8px; max-width: 54ch; color: #e1e9e4; font-size: clamp(16px, 4vw, 19px); line-height: 1.55; white-space: pre-wrap; }
  .empty { padding: 46px 0 0 26px; color: #7f9088; }
  .empty p { font: 700 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .1em; text-transform: uppercase; }
  .empty strong { display: block; margin-top: 12px; color: #d8e2dc; font-size: 20px; font-weight: 520; }
  .dock { position: sticky; bottom: 0; min-height: 100px; padding: 17px clamp(20px, 5vw, 42px) max(17px, env(safe-area-inset-bottom)); border-top: 1px solid #415048; display: flex; align-items: center; justify-content: space-between; gap: 20px; background: rgba(13, 19, 17, .94); backdrop-filter: blur(18px); }
  .dock-label { color: #75877f; font: 700 10px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .12em; text-transform: uppercase; }
  .dock-status { margin-top: 5px; color: #edf3ef; line-height: 1.35; }
  .dock-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 9px; }
  button { border: 1px solid #b6f29d; border-radius: 999px; padding: 10px 17px; color: #08100b; background: #b6f29d; cursor: pointer; font-weight: 760; }
  button.secondary { color: #dce7e0; border-color: #4d5d55; background: #1b2521; }
  button:disabled { opacity: .55; cursor: wait; }
  button:focus-visible, input:focus-visible { outline: 2px solid #a7f4da; outline-offset: 3px; }
  .latest { position: absolute; right: clamp(28px, 7vw, 54px); bottom: 16px; padding: 7px 12px; border-color: #52645b; color: #dce7e0; background: #1b2521; font-size: 12px; }
  .pair-form { display: grid; grid-template-columns: minmax(110px, 160px) auto; gap: 7px; align-items: end; }
  .pair-form label { grid-column: 1 / -1; color: #8fa097; font-size: 11px; }
  .pair-form input { min-width: 0; border: 1px solid #526159; border-radius: 5px; padding: 9px; color: #eff5f1; background: #111815; font: 750 18px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .15em; }
  .pair-form button { border-radius: 5px; padding: 9px 13px; }
  .error { grid-column: 1 / -1; margin: 0; color: #ff9e92; font-size: 12px; }
  @media (max-width: 480px) { .connection { align-items: flex-start; } .pair-form { grid-template-columns: 1fr; } .pair-form label, .pair-form .error { grid-column: auto; } .dock { align-items: flex-start; } }
  @media (prefers-reduced-motion: reduce) { .ledger { scroll-behavior: auto; } }
</style>`;

import type { AppState } from './state';

export interface CompanionActions {
  onPair(code: string): Promise<void>;
  onRetry(): Promise<void>;
  onNewTurn(): Promise<void>;
}

export interface CompanionUi {
  render(state: AppState): void;
}

const labels: Record<AppState['kind'], string> = {
  booting: 'Connecting',
  pairing: 'Pairing required',
  ready: 'Ready',
  recording: 'Recording',
  uploading: 'Sending',
  transcribing: 'Transcribing',
  thinking: 'NanoClaw is thinking',
  answer: 'Answer ready',
  error: 'Needs attention',
};

export function mountCompanionUi(actions: CompanionActions): CompanionUi {
  const root = document.querySelector<HTMLDivElement>('#app');
  if (!root) throw new Error('Companion root is missing');
  root.innerHTML = `
    <style>
      :root {
        color: #dce9e4;
        background: #0b100f;
        font-family: "Avenir Next", "Trebuchet MS", sans-serif;
        font-synthesis: none;
      }
      * { box-sizing: border-box; }
      body { margin: 0; min-width: 280px; min-height: 100vh; background: #0b100f; }
      button, input { font: inherit; }
      .shell {
        min-height: 100vh;
        display: grid;
        grid-template-columns: 22px minmax(0, 1fr);
        gap: 20px;
        padding: clamp(22px, 7vw, 54px);
        max-width: 720px;
        margin: 0 auto;
      }
      .ray {
        position: relative;
        border-left: 1px solid #35453f;
        margin-left: 10px;
      }
      .ray::before {
        content: "";
        position: absolute;
        width: 9px;
        height: 9px;
        border-radius: 50%;
        left: -5px;
        top: 66px;
        background: #8bd5c8;
        box-shadow: 0 0 0 6px #17211e, 0 0 22px rgba(139, 213, 200, .42);
        transition: top 220ms ease;
      }
      .ray[data-step="pairing"]::before { top: 66px; background: #ffc17a; }
      .ray[data-step="ready"]::before, .ray[data-step="recording"]::before { top: 126px; }
      .ray[data-step="uploading"]::before, .ray[data-step="transcribing"]::before { top: 186px; }
      .ray[data-step="thinking"]::before { top: 246px; }
      .ray[data-step="answer"]::before { top: 306px; background: #c9ffb1; }
      .ray[data-step="error"]::before { background: #ff8f82; }
      main { min-width: 0; }
      .eyebrow {
        margin: 0 0 30px;
        color: #8bd5c8;
        font: 700 11px/1.2 "Courier New", monospace;
        letter-spacing: .16em;
        text-transform: uppercase;
      }
      h1 {
        margin: 0;
        max-width: 12ch;
        color: #f3f8f5;
        font-size: clamp(34px, 9vw, 62px);
        font-weight: 500;
        line-height: .98;
        letter-spacing: -.045em;
      }
      .instruction { color: #9cadA6; line-height: 1.55; margin: 20px 0 0; max-width: 42ch; }
      .panel { border-top: 1px solid #35453f; margin-top: 38px; padding-top: 22px; }
      .metric {
        font: 700 13px/1.4 "Courier New", monospace;
        color: #c9ffb1;
        letter-spacing: .03em;
      }
      .answer {
        white-space: pre-wrap;
        color: #edf5f0;
        line-height: 1.6;
        margin: 16px 0;
      }
      .transcript { color: #84958e; font-size: 13px; margin-top: 18px; }
      form { display: grid; gap: 12px; max-width: 360px; }
      label { color: #9cada6; font-size: 13px; }
      input {
        width: 100%;
        border: 1px solid #42544d;
        border-radius: 3px;
        background: #111916;
        color: #f3f8f5;
        padding: 14px 15px;
        font: 700 24px/1 "Courier New", monospace;
        letter-spacing: .22em;
      }
      input:focus-visible, button:focus-visible { outline: 2px solid #8bd5c8; outline-offset: 3px; }
      button {
        justify-self: start;
        border: 0;
        border-radius: 3px;
        padding: 12px 17px;
        color: #0b100f;
        background: #c9ffb1;
        cursor: pointer;
        font-weight: 700;
      }
      button.secondary { color: #dce9e4; background: #25332e; }
      button:disabled { opacity: .55; cursor: wait; }
      .error { color: #ff9e92; line-height: 1.5; }
      @media (prefers-reduced-motion: reduce) { .ray::before { transition: none; } }
    </style>
    <div class="shell">
      <aside class="ray" aria-hidden="true"></aside>
      <main>
        <p class="eyebrow">NanoClaw / G2 voice link</p>
        <section id="state" aria-live="polite"></section>
      </main>
    </div>
  `;
  const stateRoot = root.querySelector<HTMLElement>('#state')!;
  const ray = root.querySelector<HTMLElement>('.ray')!;

  stateRoot.addEventListener('submit', (event) => {
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
  stateRoot.addEventListener('click', (event) => {
    const action = (event.target as HTMLElement).closest<HTMLButtonElement>(
      'button[data-action]',
    )?.dataset.action;
    if (action === 'retry') void actions.onRetry().catch(() => undefined);
    if (action === 'new') void actions.onNewTurn().catch(() => undefined);
  });

  return {
    render(state) {
      ray.dataset.step = state.kind;
      stateRoot.innerHTML = renderState(state);
    },
  };
}

function renderState(state: AppState): string {
  const heading = `<h1>${labels[state.kind]}</h1>`;
  switch (state.kind) {
    case 'booting':
      return `${heading}<p class="instruction">Opening the private link to your NanoClaw host.</p>`;
    case 'pairing':
      return `${heading}
        <p class="instruction">Run <code>npm run evenhub:pair</code> on the host, then enter its six-digit code.</p>
        <div class="panel">
          <form id="pairForm">
            <label for="pairCode">One-time pairing code</label>
            <input id="pairCode" name="code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code" required />
            <button type="submit">Pair this G2</button>
          </form>
          ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ''}
        </div>`;
    case 'ready':
      return `${heading}<p class="instruction">Tap either temple to record. Tap once more to send the turn.</p>`;
    case 'recording':
      return `${heading}<p class="instruction">Speak naturally, then tap to send.</p><div class="panel metric">${(state.bytes / 32_000).toFixed(1)} seconds captured</div>`;
    case 'uploading':
      return `${heading}<p class="instruction">Securing the recorded audio on your local host.</p>`;
    case 'transcribing':
      return `${heading}<p class="instruction">Local speech recognition is reading the recording.</p>${state.transcript ? `<p class="transcript">${escapeHtml(state.transcript)}</p>` : ''}${state.notice ? `<p class="metric">${escapeHtml(state.notice)}</p>` : ''}`;
    case 'thinking':
      return `${heading}<p class="instruction">The turn is now in the same context path as WhatsApp.</p>${state.transcript ? `<p class="transcript">${escapeHtml(state.transcript)}</p>` : ''}${state.notice ? `<p class="metric">${escapeHtml(state.notice)}</p>` : ''}`;
    case 'answer':
      return `${heading}<div class="panel"><div class="metric">Page ${state.page + 1} / ${state.pages.length}</div><p class="answer">${escapeHtml(state.pages[state.page])}</p><button class="secondary" data-action="new">Record another turn</button>${state.transcript ? `<p class="transcript">Heard: ${escapeHtml(state.transcript)}</p>` : ''}</div>`;
    case 'error':
      return `${heading}<p class="error">${escapeHtml(state.message)}</p><div class="panel">${state.retryable ? '<button data-action="retry">Try again</button>' : '<button class="secondary" data-action="new">Return to ready</button>'}</div>`;
  }
}

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"]/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]!,
  );
}

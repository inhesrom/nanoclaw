import { describe, expect, it, vi } from 'vitest';

import { CoalescingGlassesRenderer } from '../src/glasses-renderer';
import { handlePrimaryTap } from '../src/primary-tap';
import type { AppState, SessionState } from '../src/state';
import { renderCompanionState } from '../src/ui';

describe('CoalescingGlassesRenderer', () => {
  it('drops stale listening frames so captured state renders next', async () => {
    let releaseFirstWrite!: () => void;
    const firstWritePending = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const contents: string[] = [];
    let writes = 0;
    const renderer = new CoalescingGlassesRenderer({
      bridge: {
        async textContainerUpgrade(update) {
          contents.push(update.content || '');
          writes += 1;
          if (writes === 1) await firstWritePending;
        },
      },
      onError: vi.fn(),
    });

    renderer.render({ body: 'You: live 0.1', pager: 'Listening' });
    await Promise.resolve();
    renderer.render({ body: 'You: live 0.2', pager: 'Listening' });
    renderer.render({ body: 'You: complete draft', pager: 'Transcribing' });

    releaseFirstWrite();
    await renderer.waitForIdle();

    expect(contents).toEqual([
      'You: live 0.1',
      'Listening',
      'You: complete draft',
      'Transcribing',
    ]);
  });
});

describe('handlePrimaryTap', () => {
  it('uses one tap to start and the next tap to stop recording', async () => {
    const ready = createActions({ kind: 'ready', session: emptySession() });
    await handlePrimaryTap(ready);
    expect(ready.recorder.start).toHaveBeenCalledOnce();

    const recording = createActions({
      kind: 'recording',
      startedAt: 1,
      bytes: 8_000,
      session: emptySession(),
    });
    await handlePrimaryTap(recording);
    expect(recording.recorder.finish).toHaveBeenCalledOnce();
  });

  it('opens confirmation on the first review tap', async () => {
    const actions = createActions(reviewState(false));
    await handlePrimaryTap(actions);
    expect(actions.controller.openConfirmationChoice).toHaveBeenCalledOnce();
    expect(actions.controller.confirm).not.toHaveBeenCalled();
  });

  it('confirms the selected choice on the next tap', async () => {
    const actions = createActions(reviewState(true));
    await handlePrimaryTap(actions);
    expect(actions.controller.confirm).toHaveBeenCalledOnce();
    expect(actions.recorder.start).not.toHaveBeenCalled();
  });

  it('starts replacement recording only after discard acknowledgement', async () => {
    const actions = createActions(reviewState(true), 'discard');
    await handlePrimaryTap(actions);
    expect(actions.controller.confirm).toHaveBeenCalledOnce();
    expect(actions.recorder.start).toHaveBeenCalledOnce();
  });
});

describe('companion conversation ledger', () => {
  it('renders chronological You and NanoClaw signals without page counters', () => {
    const html = renderCompanionState({
      kind: 'ready',
      session: {
        ...emptySession(),
        turns: [
          {
            turnId: 'turn-1',
            transcript: '<first request>',
            reply: 'first answer',
          },
          {
            turnId: 'turn-2',
            transcript: 'second request',
            reply: 'second answer',
          },
        ],
      },
    });

    expect(html).toContain('<p class="speaker">You</p>');
    expect(html).toContain('&lt;first request&gt;');
    expect(html).toContain('first answer');
    expect(html).toContain('second answer');
    expect(html).not.toMatch(/Page \d|Turn \d/);
  });

  it('mirrors Send and Try again while the draft is unresolved', () => {
    const html = renderCompanionState(reviewState(false));
    expect(html).toContain('data-action="send"');
    expect(html).toContain('data-action="discard"');
    expect(html).toContain('Nothing has been sent');
  });
});

function createActions(state: AppState, decision: 'send' | 'discard' = 'send') {
  return {
    controller: {
      state,
      openConfirmationChoice: vi.fn(),
      confirm: vi.fn(async () => decision),
    },
    recorder: {
      start: vi.fn(async () => undefined),
      finish: vi.fn(async () => undefined),
    },
  };
}

function reviewState(choiceOpen: boolean): AppState {
  return {
    kind: 'review',
    turn: { id: 'turn-1', idempotencyKey: 'key-1' },
    transcript: 'draft transcript',
    choiceOpen,
    choice: 'send',
    session: emptySession(),
  };
}

function emptySession(): SessionState {
  return { turns: [], scrollOffset: 0, manuallyScrolled: false };
}

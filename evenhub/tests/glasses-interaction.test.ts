import { describe, expect, it, vi } from 'vitest';

import {
  contextualScrollHint,
  createG2StartupContainers,
  glassesView,
} from '../src/g2-display';
import { CoalescingGlassesRenderer } from '../src/glasses-renderer';
import { handlePrimaryTap } from '../src/primary-tap';
import { G2_FEED_LINES } from '../src/conversation-layout';
import type { AppState, SessionState } from '../src/state';
import {
  THINKING_STATUS_FRAMES,
  THINKING_STATUS_INTERVAL_MS,
  ThinkingStatusAnimation,
} from '../src/thinking-status';
import {
  limitComposerText,
  renderCompanionState,
  shouldClearComposer,
} from '../src/ui';

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

    renderer.render({
      feed: 'You: live 0.1',
      scrollbar: '█\n│',
      status: 'Tap to stop',
    });
    await Promise.resolve();
    renderer.render({
      feed: 'You: live 0.2',
      scrollbar: '█\n│',
      status: 'Tap to stop',
    });
    renderer.render({
      feed: 'You: complete draft',
      scrollbar: '│\n█',
      status: 'Transcribing…',
    });

    releaseFirstWrite();
    await renderer.waitForIdle();

    expect(contents).toEqual([
      'You: live 0.1',
      'You: complete draft',
      '│\n█',
      'Transcribing…',
    ]);
  });

  it('updates thinking status frames without resending an unchanged feed', async () => {
    const updates: Array<{ name?: string; content?: string }> = [];
    const renderer = new CoalescingGlassesRenderer({
      bridge: {
        async textContainerUpgrade(update) {
          updates.push({
            name: update.containerName,
            content: update.content,
          });
        },
      },
      onError: vi.fn(),
    });

    for (const status of THINKING_STATUS_FRAMES) {
      renderer.render({ feed: 'You: complete draft', scrollbar: '', status });
      await renderer.waitForIdle();
    }

    expect(
      updates
        .filter((update) => update.name === 'feed')
        .map((item) => item.content),
    ).toEqual(['You: complete draft']);
    expect(
      updates
        .filter((update) => update.name === 'status')
        .map((item) => item.content),
    ).toEqual(THINKING_STATUS_FRAMES);
  });

  it('diffs scrollbar and status updates without resending the feed', async () => {
    const updates: Array<{ name?: string; content?: string }> = [];
    const renderer = new CoalescingGlassesRenderer({
      bridge: {
        async textContainerUpgrade(update) {
          updates.push({ name: update.containerName, content: update.content });
        },
      },
      onError: vi.fn(),
    });

    renderer.render({ feed: 'same feed', scrollbar: '█\n│', status: 'First' });
    await renderer.waitForIdle();
    renderer.render({ feed: 'same feed', scrollbar: '│\n█', status: 'First' });
    await renderer.waitForIdle();
    renderer.render({ feed: 'same feed', scrollbar: '│\n█', status: 'Second' });
    await renderer.waitForIdle();

    expect(updates.filter((update) => update.name === 'feed')).toHaveLength(1);
    expect(
      updates.filter((update) => update.name === 'scrollbar'),
    ).toHaveLength(2);
    expect(updates.filter((update) => update.name === 'status')).toHaveLength(
      2,
    );
  });
});

describe('G2 display', () => {
  it('creates a framed three-container stack with capture only on status', () => {
    const containers = createG2StartupContainers({
      feed: 'NanoClaw',
      scrollbar: '',
      status: 'Tap to record',
    });

    expect(containers).toHaveLength(4);
    expect(G2_FEED_LINES).toBe(8);
    expect(containers[0]).toMatchObject({
      xPosition: 2,
      yPosition: 2,
      width: 572,
      height: 284,
      borderWidth: 1,
      borderRadius: 8,
      zOrderIndex: 1,
    });
    expect(containers[1]).toMatchObject({
      containerName: 'feed',
      width: 552,
      height: 240,
      zOrderIndex: 2,
    });
    expect(containers[1].isEventCapture).toBeUndefined();
    expect(containers[2]).toMatchObject({
      containerName: 'scrollbar',
      xPosition: 552,
      width: 24,
      height: 240,
      zOrderIndex: 3,
    });
    expect(containers[2].isEventCapture).toBeUndefined();
    expect(containers[3]).toMatchObject({
      containerName: 'status',
      yPosition: 250,
      height: 30,
      isEventCapture: 1,
      zOrderIndex: 4,
    });
    expect(containers.filter((item) => item.isEventCapture === 1)).toHaveLength(
      1,
    );
    expect(new Set(containers.map((item) => item.zOrderIndex)).size).toBe(4);
  });

  it('uses exact sentence-case status copy and contextual scroll arrows', () => {
    expect(contextualScrollHint(false, false)).toBe('');
    expect(contextualScrollHint(true, false)).toBe('Scroll ↑');
    expect(contextualScrollHint(false, true)).toBe('Scroll ↓');
    expect(contextualScrollHint(true, true)).toBe('Scroll ↑↓');

    expect(
      glassesView({
        kind: 'ready',
        capabilities: { voice: true, text: true },
        session: emptySession(),
      }).status,
    ).toBe('Tap to record');
    expect(
      glassesView({
        kind: 'recording',
        startedAt: 1,
        bytes: 8_000,
        capabilities: { voice: true, text: true },
        session: emptySession(),
      }).status,
    ).toBe('Tap to stop');
    expect(
      glassesView({
        kind: 'stopping',
        finalText: 'complete draft',
        capabilities: { voice: true, text: true },
        session: emptySession(),
      }).status,
    ).toBe('Transcribing…');
  });

  it('gives the open choice strip precedence over overflow hints', () => {
    const state = reviewState(true);
    state.session.turns = new Array(12).fill(undefined).map((_, index) => ({
      turnId: `prior-${index}`,
      transcript: `earlier prompt ${index}`,
      reply: `earlier reply ${index}`,
    }));
    state.session.manuallyScrolled = true;
    state.session.scrollOffset = 4;

    expect(glassesView(state).status).toBe('› Send     Try again');
    expect(glassesView(state).status).not.toContain('Scroll');
  });

  it('projects the ready-to-error simulator states into nonempty frames', () => {
    const turn = { id: 'turn-1', idempotencyKey: 'key-1' };
    const states: Array<{ state: AppState; expectedStatus: string }> = [
      {
        state: {
          kind: 'ready',
          capabilities: { voice: true, text: true },
          session: emptySession(),
        },
        expectedStatus: 'Tap to record',
      },
      {
        state: {
          kind: 'recording',
          startedAt: 1,
          bytes: 8_000,
          finalText: 'live',
          interimText: 'draft',
          session: emptySession(),
        },
        expectedStatus: 'Tap to stop',
      },
      {
        state: {
          kind: 'stopping',
          finalText: 'complete',
          interimText: 'draft',
          session: emptySession(),
        },
        expectedStatus: 'Transcribing…',
      },
      {
        state: {
          kind: 'transcribing',
          turn,
          transcript: 'complete draft',
          session: emptySession(),
        },
        expectedStatus: 'Transcribing…',
      },
      {
        state: reviewState(true),
        expectedStatus: '› Send     Try again',
      },
      {
        state: {
          kind: 'thinking',
          turn,
          transcript: 'complete draft',
          session: emptySession(),
        },
        expectedStatus: 'Thinking..',
      },
      {
        state: {
          kind: 'error',
          message: 'Host unavailable',
          retryable: true,
          session: emptySession(),
        },
        expectedStatus: 'Retry in companion',
      },
    ];

    for (const { state, expectedStatus } of states) {
      const view = glassesView(state, 'Thinking..');
      expect(view.feed.length).toBeGreaterThan(0);
      expect(view.status).toBe(expectedStatus);
    }
  });
});

describe('ThinkingStatusAnimation', () => {
  it('cycles every 600 ms and stops outside thinking', () => {
    vi.useFakeTimers();
    try {
      const onFrame = vi.fn();
      const animation = new ThinkingStatusAnimation(onFrame);

      animation.sync(true);
      expect(animation.status).toBe('Thinking');
      for (const frame of THINKING_STATUS_FRAMES.slice(1)) {
        vi.advanceTimersByTime(THINKING_STATUS_INTERVAL_MS);
        expect(animation.status).toBe(frame);
      }
      vi.advanceTimersByTime(THINKING_STATUS_INTERVAL_MS);
      expect(animation.status).toBe('Thinking');
      expect(onFrame).toHaveBeenCalledTimes(4);

      animation.sync(false);
      vi.advanceTimersByTime(THINKING_STATUS_INTERVAL_MS * 2);
      expect(onFrame).toHaveBeenCalledTimes(4);
      expect(animation.status).toBe('Thinking');
      animation.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('handlePrimaryTap', () => {
  it('uses one tap to start and the next tap to stop recording', async () => {
    const ready = createActions({
      kind: 'ready',
      capabilities: { voice: true, text: true },
      session: emptySession(),
    });
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

  it('does not open recording from a G2 tap when voice is unavailable', async () => {
    const actions = createActions({
      kind: 'ready',
      capabilities: { voice: false, text: true },
      session: emptySession(),
    });

    await handlePrimaryTap(actions);

    expect(actions.recorder.start).not.toHaveBeenCalled();
  });

  it('does not expose confirmation before the final server transcript', async () => {
    const actions = createActions({
      kind: 'stopping',
      finalText: 'partial draft',
      session: emptySession(),
    });
    await handlePrimaryTap(actions);
    expect(actions.controller.openConfirmationChoice).not.toHaveBeenCalled();
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
  it('limits composer text by Unicode code point rather than UTF-16 units', () => {
    expect(limitComposerText(`a${'👓'.repeat(2_000)}z`)).toBe(
      `a${'👓'.repeat(1_999)}`,
    );
    expect([...limitComposerText('👓'.repeat(2_001))]).toHaveLength(2_000);
  });

  it('clears a draft only after host acknowledgement, not submission failure', () => {
    expect(shouldClearComposer('submitting_text', 'thinking')).toBe(true);
    expect(shouldClearComposer('submitting_text', 'ready')).toBe(true);
    expect(shouldClearComposer('submitting_text', 'error')).toBe(false);
  });

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

  it('shows a multiline composer after pairing and disables it while busy', () => {
    const ready = renderCompanionState({
      kind: 'ready',
      capabilities: { voice: false, text: true },
      session: emptySession(),
    });
    expect(ready).toContain('placeholder="Type a message…"');
    expect(ready).toContain('<textarea rows="3"');
    expect(ready).not.toContain('<textarea rows="3" disabled');

    const busy = renderCompanionState({
      kind: 'submitting_text',
      idempotencyKey: 'key-text',
      text: 'hello',
      capabilities: { voice: false, text: true },
      session: emptySession(),
    });
    expect(busy).toContain('placeholder="Type a message…" disabled');
    expect(busy).toContain('Sending…');
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

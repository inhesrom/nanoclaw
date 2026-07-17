import { describe, expect, it, vi } from 'vitest';

import { CoalescingGlassesRenderer } from '../src/glasses-renderer';
import { handlePrimaryTap } from '../src/primary-tap';
import type { AppState } from '../src/state';
import { renderCompanionState } from '../src/ui';

describe('CoalescingGlassesRenderer', () => {
  it('drops stale recording frames so a captured state is rendered next', async () => {
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

    renderer.render({ body: 'Recording 0.1', pager: 'Tap: send' });
    await Promise.resolve();
    for (let tenth = 2; tenth <= 20; tenth += 1) {
      renderer.render({
        body: `Recording ${(tenth / 10).toFixed(1)}`,
        pager: 'Tap: send',
      });
    }
    renderer.render({ body: 'Audio captured', pager: 'Microphone closed' });

    releaseFirstWrite();
    await renderer.waitForIdle();

    expect(contents).toEqual([
      'Recording 0.1',
      'Tap: send',
      'Audio captured',
      'Microphone closed',
    ]);
  });
});

describe('handlePrimaryTap', () => {
  it('advances an answer that has another page', async () => {
    const state: AppState = {
      kind: 'answer',
      turnId: 'turn-1',
      pages: ['one', 'two'],
      page: 0,
      session: {
        turns: [{ turnId: 'turn-1', pages: ['one', 'two'] }],
        turn: 0,
      },
    };
    const actions = createActions(state);

    await handlePrimaryTap(actions);

    expect(actions.controller.nextPage).toHaveBeenCalledOnce();
    expect(actions.controller.newTurn).not.toHaveBeenCalled();
    expect(actions.recorder.start).not.toHaveBeenCalled();
  });

  it('starts another recording from the final answer page', async () => {
    const state: AppState = {
      kind: 'answer',
      turnId: 'turn-1',
      pages: ['only page'],
      page: 0,
      session: {
        turns: [{ turnId: 'turn-1', pages: ['only page'] }],
        turn: 0,
      },
    };
    const actions = createActions(state);

    await handlePrimaryTap(actions);

    expect(actions.controller.newTurn).toHaveBeenCalledOnce();
    expect(actions.recorder.start).toHaveBeenCalledOnce();
    expect(actions.controller.nextPage).not.toHaveBeenCalled();
  });

  it('returns from an older turn to the next turn before recording', async () => {
    const state: AppState = {
      kind: 'answer',
      turnId: 'turn-1',
      pages: ['first answer'],
      page: 0,
      session: {
        turns: [
          { turnId: 'turn-1', pages: ['first answer'] },
          { turnId: 'turn-2', pages: ['second answer'] },
        ],
        turn: 0,
      },
    };
    const actions = createActions(state);

    await handlePrimaryTap(actions);

    expect(actions.controller.nextPage).toHaveBeenCalledOnce();
    expect(actions.controller.newTurn).not.toHaveBeenCalled();
    expect(actions.recorder.start).not.toHaveBeenCalled();
  });
});

describe('companion session history', () => {
  it('keeps prior turns scrollable while another turn is ready', () => {
    const html = renderCompanionState({
      kind: 'ready',
      session: {
        turns: [
          {
            turnId: 'turn-1',
            transcript: '<first request>',
            pages: ['first answer'],
          },
          { turnId: 'turn-2', pages: ['second answer'] },
        ],
        turn: 1,
      },
    });

    expect(html).toContain('Session turns');
    expect(html).toContain('Turn 1');
    expect(html).toContain('Turn 2');
    expect(html).toContain('&lt;first request&gt;');
    expect(html).toContain('first answer');
    expect(html).toContain('second answer');
  });
});

function createActions(state: AppState) {
  return {
    controller: {
      state,
      newTurn: vi.fn(async () => undefined),
      nextPage: vi.fn(),
    },
    recorder: {
      start: vi.fn(async () => undefined),
      finish: vi.fn(async () => undefined),
    },
  };
}

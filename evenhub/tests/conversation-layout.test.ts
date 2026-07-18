import { describe, expect, it } from 'vitest';

import {
  anchorConversationEntry,
  projectConversationFeed,
  scrollConversation,
} from '../src/conversation-layout';

describe('conversation feed layout', () => {
  it('places several short exchanges in one eight-line viewport', () => {
    const projection = projectConversationFeed([
      { id: '1-you', speaker: 'You', text: 'Status?' },
      { id: '1-reply', speaker: 'NanoClaw', text: 'All clear.' },
      { id: '2-you', speaker: 'You', text: 'Next step?' },
      { id: '2-reply', speaker: 'NanoClaw', text: 'Ship it.' },
    ]);

    expect(projection.lines).toHaveLength(7);
    expect(projection.body).toContain('You: Status?');
    expect(projection.body).toContain('NanoClaw: Ship it.');
    expect(projection.hasEarlier).toBe(false);
    expect(projection.hasLater).toBe(false);
  });

  it('wraps long prompts and replies without truncation', () => {
    const text = new Array(80).fill('continuous').join(' ');
    const projection = projectConversationFeed(
      [
        { id: 'you', speaker: 'You', text },
        { id: 'reply', speaker: 'NanoClaw', text },
      ],
      { width: 180, viewportLines: 8, offset: 0 },
    );

    expect(projection.lines.length).toBeGreaterThan(16);
    expect(projection.lines.join(' ')).toContain(text);
    expect(projection.body.split('\n')).toHaveLength(8);
  });

  it('scrolls by four wrapped lines and clamps both edges', () => {
    const entries = new Array(12).fill(undefined).map((_, index) => ({
      id: String(index),
      speaker: 'You' as const,
      text: `message ${index}`,
    }));
    const start = projectConversationFeed(entries, { offset: 0 });
    expect(scrollConversation(start, -1)).toBe(0);
    expect(scrollConversation(start, 1)).toBe(4);

    const end = projectConversationFeed(entries, { offset: 10_000 });
    expect(end.offset).toBe(end.maxOffset);
    expect(scrollConversation(end, 1)).toBe(end.maxOffset);
  });

  it('anchors short replies with context and long replies at their beginning', () => {
    const short = projectConversationFeed([
      {
        id: 'prompt',
        speaker: 'You',
        text: new Array(20).fill('context').join(' '),
      },
      { id: 'reply', speaker: 'NanoClaw', text: 'Done.' },
    ]);
    const shortAnchor = anchorConversationEntry(short, 'reply');
    expect(shortAnchor).toBeLessThan(short.ranges.reply.start);

    const long = projectConversationFeed([
      { id: 'prompt', speaker: 'You', text: 'question' },
      {
        id: 'reply',
        speaker: 'NanoClaw',
        text: new Array(160).fill('answer').join(' '),
      },
    ]);
    expect(anchorConversationEntry(long, 'reply')).toBe(
      long.ranges.reply.start,
    );
  });
});

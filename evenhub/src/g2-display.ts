import { TextContainerProperty } from '@evenrealities/even_hub_sdk';

import { conversationProjectionForState } from './controller';
import type { AppState } from './state';

export interface GlassesView {
  feed: string;
  status: string;
}

export const G2_CONTAINER_LAYOUT = {
  frame: {
    xPosition: 2,
    yPosition: 2,
    width: 572,
    height: 284,
    borderWidth: 1,
    borderColor: 5,
    borderRadius: 8,
    paddingLength: 0,
    containerID: 1,
    containerName: 'frame',
    zOrderIndex: 1,
  },
  feed: {
    xPosition: 0,
    yPosition: 0,
    width: 576,
    height: 240,
    borderWidth: 0,
    borderColor: 5,
    borderRadius: 0,
    paddingLength: 4,
    containerID: 2,
    containerName: 'feed',
    zOrderIndex: 2,
  },
  status: {
    xPosition: 0,
    yPosition: 250,
    width: 576,
    height: 30,
    borderWidth: 0,
    borderColor: 5,
    borderRadius: 0,
    paddingLength: 4,
    containerID: 3,
    containerName: 'status',
    isEventCapture: 1,
    zOrderIndex: 3,
  },
} as const;

export function createG2StartupContainers(
  view: GlassesView,
): TextContainerProperty[] {
  return [
    new TextContainerProperty({ ...G2_CONTAINER_LAYOUT.frame, content: '' }),
    new TextContainerProperty({
      ...G2_CONTAINER_LAYOUT.feed,
      content: view.feed,
    }),
    new TextContainerProperty({
      ...G2_CONTAINER_LAYOUT.status,
      content: view.status,
    }),
  ];
}

export function glassesView(
  state: AppState,
  thinkingStatus = 'Thinking',
): GlassesView {
  const feed = conversationProjectionForState(state);
  const feedBody = feed.body || 'NanoClaw\n\nTap to record';
  const hint = contextualScrollHint(feed.hasEarlier, feed.hasLater);
  switch (state.kind) {
    case 'booting':
      return {
        feed: 'NanoClaw\nConnecting…',
        status: 'Private Tailscale voice link',
      };
    case 'pairing':
      return {
        feed: `Pairing required\n\nOpen the companion screen.${state.error ? `\n\n${state.error}` : ''}`,
        status: 'Companion setup',
      };
    case 'ready':
      return {
        feed: feedBody,
        status: joinStatus(hint, 'Tap to record'),
      };
    case 'recording':
      return {
        feed: feed.body || 'Listening…',
        status: joinStatus(hint, 'Tap to stop'),
      };
    case 'stopping':
    case 'uploading':
    case 'transcribing':
      return {
        feed: feed.body || 'Transcribing…',
        status: joinStatus(hint, 'Transcribing…'),
      };
    case 'review':
      return {
        feed: feedBody,
        status: state.choiceOpen
          ? state.choice === 'send'
            ? '› Send     Try again'
            : '  Send   › Try again'
          : joinStatus(hint, state.notice || 'Tap to choose'),
      };
    case 'thinking':
      return {
        feed: feed.body || 'NanoClaw is thinking…',
        status: joinStatus(hint, thinkingStatus),
      };
    case 'error':
      return {
        feed: feed.body || 'NanoClaw',
        status: state.retryable ? 'Retry in companion' : 'Return in companion',
      };
  }
}

export function contextualScrollHint(
  hasEarlier: boolean,
  hasLater: boolean,
): string {
  if (hasEarlier && hasLater) return 'Scroll ↑↓';
  if (hasEarlier) return 'Scroll ↑';
  if (hasLater) return 'Scroll ↓';
  return '';
}

function joinStatus(hint: string, status: string): string {
  return [hint, status].filter(Boolean).join(' · ');
}

import { TextContainerUpgrade } from '@evenrealities/even_hub_sdk';

import type { GlassesView } from './g2-display';

interface GlassesBridgePort {
  textContainerUpgrade(update: TextContainerUpgrade): Promise<unknown>;
}

interface CoalescingGlassesRendererOptions {
  bridge: GlassesBridgePort;
  onError: (error: unknown) => void;
}

export class CoalescingGlassesRenderer {
  private pending?: GlassesView;
  private rendering?: Promise<void>;
  private sent: Partial<GlassesView> = {};

  constructor(private readonly options: CoalescingGlassesRendererOptions) {}

  render(view: GlassesView): void {
    this.pending = view;
    this.startRendering();
  }

  async waitForIdle(): Promise<void> {
    while (this.rendering) await this.rendering;
  }

  private startRendering(): void {
    if (this.rendering) return;
    this.rendering = this.flush().finally(() => {
      this.rendering = undefined;
      if (this.pending) this.startRendering();
    });
  }

  private async flush(): Promise<void> {
    while (this.pending) {
      const view = this.pending;
      this.pending = undefined;
      try {
        if (view.feed !== this.sent.feed) {
          await this.options.bridge.textContainerUpgrade(
            new TextContainerUpgrade({
              containerID: 2,
              containerName: 'feed',
              content: view.feed,
            }),
          );
          this.sent.feed = view.feed;
        }
        if (this.pending) continue;
        if (view.scrollbar !== this.sent.scrollbar) {
          await this.options.bridge.textContainerUpgrade(
            new TextContainerUpgrade({
              containerID: 3,
              containerName: 'scrollbar',
              content: view.scrollbar,
            }),
          );
          this.sent.scrollbar = view.scrollbar;
        }
        if (this.pending) continue;
        if (view.status !== this.sent.status) {
          await this.options.bridge.textContainerUpgrade(
            new TextContainerUpgrade({
              containerID: 4,
              containerName: 'status',
              content: view.status,
            }),
          );
          this.sent.status = view.status;
        }
      } catch (error) {
        this.options.onError(error);
      }
    }
  }
}

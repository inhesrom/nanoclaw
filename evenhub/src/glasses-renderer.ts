import { TextContainerUpgrade } from '@evenrealities/even_hub_sdk';

export interface GlassesView {
  body: string;
  pager: string;
}

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
        await this.options.bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: 1,
            containerName: 'body',
            content: view.body,
          }),
        );
        await this.options.bridge.textContainerUpgrade(
          new TextContainerUpgrade({
            containerID: 2,
            containerName: 'pager',
            content: view.pager,
          }),
        );
      } catch (error) {
        this.options.onError(error);
      }
    }
  }
}

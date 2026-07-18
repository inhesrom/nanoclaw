export const THINKING_STATUS_FRAMES = [
  'Thinking',
  'Thinking.',
  'Thinking..',
  'Thinking...',
] as const;

export const THINKING_STATUS_INTERVAL_MS = 600;

interface IntervalPort {
  setInterval(callback: () => void, milliseconds: number): number;
  clearInterval(timer: number): void;
}

const browserIntervals: IntervalPort = {
  setInterval: (callback, milliseconds) =>
    globalThis.setInterval(callback, milliseconds) as unknown as number,
  clearInterval: (timer) => globalThis.clearInterval(timer),
};

export class ThinkingStatusAnimation {
  private frameIndex = 0;
  private timer?: number;

  constructor(
    private readonly onFrame: (status: string) => void,
    private readonly intervals: IntervalPort = browserIntervals,
  ) {}

  get status(): string {
    return THINKING_STATUS_FRAMES[this.frameIndex];
  }

  sync(isThinking: boolean): void {
    if (!isThinking) {
      this.stop();
      return;
    }
    if (this.timer !== undefined) return;
    this.frameIndex = 0;
    this.timer = this.intervals.setInterval(() => {
      this.frameIndex = (this.frameIndex + 1) % THINKING_STATUS_FRAMES.length;
      this.onFrame(this.status);
    }, THINKING_STATUS_INTERVAL_MS);
  }

  dispose(): void {
    this.stop();
  }

  private stop(): void {
    if (this.timer !== undefined) {
      this.intervals.clearInterval(this.timer);
      this.timer = undefined;
    }
    this.frameIndex = 0;
  }
}

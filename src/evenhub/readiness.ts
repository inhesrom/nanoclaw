export type EvenHubComponentState = 'up' | 'down';

export interface EvenHubDependencySnapshot {
  database: EvenHubComponentState;
  stt: EvenHubComponentState;
  whatsapp: EvenHubComponentState;
}

export interface EvenHubReadinessProbe {
  snapshot(): Promise<EvenHubDependencySnapshot>;
}

export interface EvenHubReadinessOptions {
  database: () => boolean | Promise<boolean>;
  stt: () => boolean | Promise<boolean>;
  whatsapp: () => boolean | Promise<boolean>;
  cacheMs?: number;
  now?: () => number;
}

async function probe(
  check: () => boolean | Promise<boolean>,
): Promise<EvenHubComponentState> {
  try {
    return (await check()) ? 'up' : 'down';
  } catch {
    return 'down';
  }
}

export class EvenHubReadiness implements EvenHubReadinessProbe {
  private readonly cacheMs: number;
  private readonly now: () => number;
  private cached?: { expiresAt: number; value: EvenHubDependencySnapshot };
  private inFlight?: Promise<EvenHubDependencySnapshot>;

  constructor(private readonly options: EvenHubReadinessOptions) {
    this.cacheMs = options.cacheMs ?? 1_000;
    this.now = options.now ?? Date.now;
  }

  async snapshot(): Promise<EvenHubDependencySnapshot> {
    if (this.cached && this.cached.expiresAt > this.now()) {
      return this.cached.value;
    }
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.sample();
    try {
      const value = await this.inFlight;
      this.cached = { expiresAt: this.now() + this.cacheMs, value };
      return value;
    } finally {
      this.inFlight = undefined;
    }
  }

  private async sample(): Promise<EvenHubDependencySnapshot> {
    const [database, stt, whatsapp] = await Promise.all([
      probe(this.options.database),
      probe(this.options.stt),
      probe(this.options.whatsapp),
    ]);
    return { database, stt, whatsapp };
  }
}

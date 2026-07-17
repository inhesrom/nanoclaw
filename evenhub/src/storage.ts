export const STORAGE_KEYS = {
  token: 'nanoclaw.evenhub.deviceToken',
  activeTurnId: 'nanoclaw.evenhub.activeTurnId',
  activeIdempotencyKey: 'nanoclaw.evenhub.activeIdempotencyKey',
  lastCompletedTurnId: 'nanoclaw.evenhub.lastCompletedTurnId',
} as const;

export interface StoragePort {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export interface EvenStorageBridge {
  getLocalStorage(key: string): Promise<string | null>;
  setLocalStorage(key: string, value: string): Promise<boolean>;
}

export class BridgeStorage implements StoragePort {
  constructor(private readonly bridge: EvenStorageBridge) {}

  get(key: string): Promise<string | null> {
    return this.bridge.getLocalStorage(key);
  }

  async set(key: string, value: string): Promise<void> {
    const stored = await this.bridge.setLocalStorage(key, value);
    if (!stored) throw new Error(`Could not persist ${key}`);
  }
}

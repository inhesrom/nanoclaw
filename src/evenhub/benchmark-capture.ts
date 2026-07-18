import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

export const EVENHUB_CAPTURE_COUNT = 30;

export interface CaptureStatus {
  armed: boolean;
  count: number;
  captured: number;
  output?: string;
}

export interface CapturedPcm {
  sequence: number;
  file: string;
  durationMs: number;
  bytes: number;
  sha256: string;
  capturedAt: string;
}

interface CaptureState extends CaptureStatus {
  version: 1;
  output: string;
  files: CapturedPcm[];
}

export interface CaptureLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
}

const silentLogger: CaptureLogger = {
  info: () => undefined,
  warn: () => undefined,
};

/**
 * Explicit, filesystem-backed switch for the physical G2 benchmark corpus.
 * The state lives below ignored store/evenhub; captured PCM never does.
 */
export class EvenHubBenchmarkCapture {
  private readonly stateDir: string;
  private readonly statePath: string;
  private readonly logger: CaptureLogger;

  constructor(
    storeDir: string,
    private readonly projectRoot: string,
    logger: CaptureLogger = silentLogger,
  ) {
    this.stateDir = path.join(storeDir, 'evenhub');
    this.statePath = path.join(this.stateDir, 'benchmark-capture.json');
    this.logger = logger;
  }

  arm(output: string, count = EVENHUB_CAPTURE_COUNT): CaptureStatus {
    return this.withLock(() => this.armUnlocked(output, count));
  }

  private armUnlocked(
    output: string,
    count = EVENHUB_CAPTURE_COUNT,
  ): CaptureStatus {
    if (count !== EVENHUB_CAPTURE_COUNT) {
      throw new Error(`capture count must be ${EVENHUB_CAPTURE_COUNT}`);
    }
    const resolved = path.resolve(output);
    if (!path.isAbsolute(output) || resolved !== output) {
      throw new Error('capture output must be a normalized absolute path');
    }
    const existing = this.readState();
    if (existing?.armed) throw new Error('capture is already armed');
    const stat = fs.statSync(resolved, { throwIfNoEntry: false });
    if (!stat?.isDirectory()) {
      throw new Error('capture output must be an existing directory');
    }
    const realOutput = fs.realpathSync(resolved);
    const realProject = fs.realpathSync(path.resolve(this.projectRoot));
    if (isWithin(realOutput, realProject)) {
      throw new Error('capture output must be outside the git worktree');
    }
    if (fs.readdirSync(resolved).length !== 0) {
      throw new Error('capture output directory must be empty');
    }
    fs.chmodSync(realOutput, 0o700);
    const state: CaptureState = {
      version: 1,
      armed: true,
      output: realOutput,
      count,
      captured: 0,
      files: [],
    };
    try {
      this.writeIndex(state);
      this.writeState(state);
    } catch (error) {
      fs.rmSync(path.join(realOutput, 'capture-index.json'), { force: true });
      throw error;
    }
    return publicStatus(state);
  }

  status(): CaptureStatus {
    const state = this.readState();
    return state
      ? publicStatus(state)
      : { armed: false, count: EVENHUB_CAPTURE_COUNT, captured: 0 };
  }

  disarm(): CaptureStatus {
    return this.withLock(() => this.disarmUnlocked());
  }

  private disarmUnlocked(): CaptureStatus {
    const state = this.readState();
    if (!state) {
      return { armed: false, count: EVENHUB_CAPTURE_COUNT, captured: 0 };
    }
    if (state.armed) {
      state.armed = false;
      this.writeState(state);
      this.writeIndex(state);
      this.logger.info(
        { captured_files: state.captured, capture_armed: false },
        'even.capture_disarmed',
      );
    }
    return publicStatus(state);
  }

  /** Copy one already-validated PCM file. Capture failure never escapes. */
  captureValidatedPcm(
    source: string,
    durationMs: number,
    expectedSha256?: string,
  ): void {
    if (!fs.existsSync(this.statePath)) return;
    this.withLock(() =>
      this.captureValidatedPcmUnlocked(source, durationMs, expectedSha256),
    );
  }

  private captureValidatedPcmUnlocked(
    source: string,
    durationMs: number,
    expectedSha256?: string,
  ): void {
    const state = this.readState();
    if (!state?.armed) return;
    if (state.captured >= state.count) {
      this.disarmUnlocked();
      return;
    }

    const sequence = state.captured + 1;
    const file = `${String(sequence).padStart(2, '0')}.pcm`;
    const destination = path.join(state.output, file);
    const temporary = `${destination}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
    try {
      const pcm = fs.readFileSync(source);
      const sha256 = createHash('sha256').update(pcm).digest('hex');
      if (expectedSha256 && sha256 !== expectedSha256) {
        throw new Error('validated PCM changed before capture');
      }
      const handle = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(handle, pcm);
        fs.fsyncSync(handle);
      } finally {
        fs.closeSync(handle);
      }
      fs.renameSync(temporary, destination);
      const captured: CapturedPcm = {
        sequence,
        file,
        durationMs,
        bytes: pcm.byteLength,
        sha256,
        capturedAt: new Date().toISOString(),
      };
      const next: CaptureState = {
        ...state,
        armed: sequence < state.count,
        captured: sequence,
        files: [...state.files, captured],
      };
      this.writeIndex(next);
      this.writeState(next);
      this.logger.info(
        {
          captured_files: next.captured,
          capture_armed: next.armed,
          capture_complete: !next.armed && next.captured === next.count,
        },
        'even.capture_saved',
      );
    } catch (_error) {
      try {
        fs.rmSync(temporary, { force: true });
        fs.rmSync(destination, { force: true });
      } catch (_cleanupError) {
        // The capture remains disarmed even if best-effort cleanup fails.
      }
      state.armed = false;
      try {
        this.writeState(state);
        this.writeIndex(state);
      } catch (_stateError) {
        // No audio or transcript content is logged on any capture failure.
      }
      this.logger.warn(
        { capture_armed: false, captured_files: state.captured },
        'even.capture_failed',
      );
    }
  }

  private readState(): CaptureState | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.statePath, 'utf8')) as
        | CaptureState
        | undefined;
      if (
        parsed?.version !== 1 ||
        typeof parsed.output !== 'string' ||
        !Array.isArray(parsed.files)
      ) {
        throw new Error('invalid capture state');
      }
      return parsed;
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return undefined;
      }
      throw error;
    }
  }

  private writeState(state: CaptureState): void {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.stateDir, 0o700);
    atomicJson(this.statePath, state);
  }

  private writeIndex(state: CaptureState): void {
    atomicJson(path.join(state.output, 'capture-index.json'), {
      version: 1,
      armed: state.armed,
      expectedCount: state.count,
      capturedCount: state.captured,
      files: state.files,
    });
  }

  private withLock<T>(operation: () => T): T {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
    fs.chmodSync(this.stateDir, 0o700);
    const lockPath = path.join(this.stateDir, 'benchmark-capture.lock');
    let handle: number | undefined;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        handle = fs.openSync(lockPath, 'wx', 0o600);
        fs.writeFileSync(handle, `${process.pid}\n`);
        fs.fsyncSync(handle);
        break;
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            'code' in error &&
            error.code === 'EEXIST'
          )
        ) {
          throw error;
        }
        this.removeStaleLock(lockPath);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    if (handle === undefined) throw new Error('capture state is busy');
    try {
      return operation();
    } finally {
      fs.closeSync(handle);
      fs.rmSync(lockPath, { force: true });
    }
  }

  private removeStaleLock(lockPath: string): void {
    try {
      const pid = Number(fs.readFileSync(lockPath, 'utf8').trim());
      if (!Number.isInteger(pid) || pid <= 0) return;
      process.kill(pid, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
        fs.rmSync(lockPath, { force: true });
      }
    }
  }
}

function atomicJson(destination: string, value: unknown): void {
  const temporary = `${destination}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  const handle = fs.openSync(temporary, 'wx', 0o600);
  try {
    fs.writeFileSync(handle, `${JSON.stringify(value, null, 2)}\n`);
    fs.fsyncSync(handle);
  } finally {
    fs.closeSync(handle);
  }
  fs.renameSync(temporary, destination);
  fs.chmodSync(destination, 0o600);
}

function publicStatus(state: CaptureState): CaptureStatus {
  return {
    armed: state.armed,
    output: state.output,
    count: state.count,
    captured: state.captured,
  };
}

function isWithin(candidate: string, parent: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === '' ||
    (!relative.startsWith('..') && !path.isAbsolute(relative))
  );
}

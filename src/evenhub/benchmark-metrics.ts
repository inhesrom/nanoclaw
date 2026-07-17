import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

export interface ThrottlingFlags {
  raw: number | null;
  current: boolean | null;
  historical: boolean | null;
}

export interface HostMetrics {
  rssMiB: number | null;
  cpuTempC: number | null;
  throttling: ThrottlingFlags;
}

export interface MetricsCollector {
  sample(): HostMetrics;
}

export function createPiMetricsCollector(
  binaryPath: string,
  modelPath: string,
): MetricsCollector {
  return {
    sample: () => ({
      rssMiB: findWhisperRssMiB(binaryPath, modelPath),
      cpuTempC: readCpuTemperature(),
      throttling: readThrottlingFlags(),
    }),
  };
}

export async function monitorOperation<T>(
  collector: MetricsCollector,
  operation: () => Promise<T>,
  intervalMs = 25,
): Promise<{ value: T; metrics: HostMetrics }> {
  let aggregate = collector.sample();
  const timer = setInterval(() => {
    aggregate = mergeMetrics(aggregate, collector.sample());
  }, intervalMs);
  timer.unref();
  try {
    const value = await operation();
    aggregate = mergeMetrics(aggregate, collector.sample());
    return { value, metrics: aggregate };
  } finally {
    clearInterval(timer);
  }
}

export function mergeMetrics(
  left: HostMetrics,
  right: HostMetrics,
): HostMetrics {
  return {
    rssMiB: nullableMax(left.rssMiB, right.rssMiB),
    cpuTempC: nullableMax(left.cpuTempC, right.cpuTempC),
    throttling: {
      raw: nullableBitwiseOr(left.throttling.raw, right.throttling.raw),
      current: nullableOr(left.throttling.current, right.throttling.current),
      historical: nullableOr(
        left.throttling.historical,
        right.throttling.historical,
      ),
    },
  };
}

function findWhisperRssMiB(
  binaryPath: string,
  modelPath: string,
): number | null {
  let peakKb: number | null = null;
  let entries: string[];
  try {
    entries = fs.readdirSync('/proc').filter((entry) => /^\d+$/.test(entry));
  } catch (_error) {
    return null;
  }
  for (const pid of entries) {
    try {
      const cmdline = fs
        .readFileSync(path.join('/proc', pid, 'cmdline'), 'utf8')
        .replace(/\0/g, ' ');
      if (
        !cmdline.includes(modelPath) ||
        !cmdline.includes(path.basename(binaryPath))
      ) {
        continue;
      }
      const status = fs.readFileSync(path.join('/proc', pid, 'status'), 'utf8');
      const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status);
      if (match) peakKb = Math.max(peakKb ?? 0, Number(match[1]));
    } catch (_error) {
      // Processes may exit while /proc is being scanned.
    }
  }
  return peakKb === null ? null : peakKb / 1024;
}

function readCpuTemperature(): number | null {
  try {
    const raw = Number(
      fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8').trim(),
    );
    return Number.isFinite(raw) ? raw / 1000 : null;
  } catch (_error) {
    return null;
  }
}

function readThrottlingFlags(): ThrottlingFlags {
  const result = spawnSync('vcgencmd', ['get_throttled'], {
    encoding: 'utf8',
    timeout: 2_000,
  });
  if (result.status !== 0)
    return { raw: null, current: null, historical: null };
  const match = /throttled=0x([a-f0-9]+)/i.exec(result.stdout);
  if (!match) return { raw: null, current: null, historical: null };
  const raw = Number.parseInt(match[1], 16);
  return {
    raw,
    current: (raw & 0xf) !== 0,
    historical: (raw & 0xf0000) !== 0,
  };
}

function nullableMax(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function nullableBitwiseOr(
  left: number | null,
  right: number | null,
): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return left | right;
}

function nullableOr(
  left: boolean | null,
  right: boolean | null,
): boolean | null {
  if (left === null) return right;
  if (right === null) return left;
  return left || right;
}

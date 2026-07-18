import fs from 'fs';
import path from 'path';

import {
  deleteExpiredEvenTurn,
  getExpiredEvenTurns,
  getReferencedEvenAudioPaths,
} from '../db.js';
import { logger as defaultLogger } from '../logger.js';

const ORPHAN_MAX_AGE_MS = 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

interface CleanupLogger {
  info(data: Record<string, unknown>, message: string): void;
  warn(data: Record<string, unknown>, message: string): void;
}

export interface EvenHubCleanupResult {
  expiredTurns: number;
  orphanFiles: number;
}

export function cleanupEvenHubStorage(
  audioDir: string,
  retentionMs: number,
  options: { now?: Date; logger?: CleanupLogger } = {},
): EvenHubCleanupResult {
  const now = options.now ?? new Date();
  const logger = options.logger ?? defaultLogger;
  const cutoff = new Date(now.getTime() - retentionMs).toISOString();
  let expiredTurns = 0;
  for (const turn of getExpiredEvenTurns(cutoff)) {
    try {
      if (turn.input_kind === 'audio') {
        fs.rmSync(turn.audio_path, { force: true });
      }
      if (deleteExpiredEvenTurn(turn.id, cutoff)) expiredTurns += 1;
    } catch {
      logger.warn(
        { turn_id: turn.id, state: turn.state },
        'even.turn_cleanup_failed',
      );
    }
  }

  const referenced = new Set(
    getReferencedEvenAudioPaths().map((audioPath) => path.resolve(audioPath)),
  );
  let orphanFiles = 0;
  if (fs.existsSync(audioDir)) {
    for (const entry of fs.readdirSync(audioDir, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.(?:part|tmp|pcm)$/.test(entry.name)) continue;
      const filePath = path.resolve(audioDir, entry.name);
      if (referenced.has(filePath)) continue;
      try {
        const stat = fs.statSync(filePath);
        if (now.getTime() - stat.mtimeMs <= ORPHAN_MAX_AGE_MS) continue;
        fs.rmSync(filePath, { force: true });
        orphanFiles += 1;
      } catch {
        logger.warn(
          { file_name: entry.name },
          'even.orphan_audio_cleanup_failed',
        );
      }
    }
  }

  if (expiredTurns > 0 || orphanFiles > 0) {
    logger.info(
      { expired_turns: expiredTurns, orphan_files: orphanFiles },
      'even.cleanup_completed',
    );
  }
  return { expiredTurns, orphanFiles };
}

export function startEvenHubCleanup(
  audioDir: string,
  retentionMs: number,
): NodeJS.Timeout {
  cleanupEvenHubStorage(audioDir, retentionMs);
  const timer = setInterval(
    () => cleanupEvenHubStorage(audioDir, retentionMs),
    CLEANUP_INTERVAL_MS,
  );
  timer.unref();
  return timer;
}

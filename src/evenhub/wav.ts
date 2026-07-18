export const EVENHUB_SAMPLE_RATE = 16_000;
export const EVENHUB_CHANNELS = 1;
export const EVENHUB_BITS_PER_SAMPLE = 16;
export const EVENHUB_BYTES_PER_SECOND =
  EVENHUB_SAMPLE_RATE * EVENHUB_CHANNELS * (EVENHUB_BITS_PER_SAMPLE / 8);
export const EVENHUB_WAV_HEADER_BYTES = 44;
export const EVENHUB_DURATION_TOLERANCE_BYTES = 640;

export class InvalidPcmError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPcmError';
  }
}

export function validateEvenHubPcm(
  pcm: Uint8Array,
  durationMs: number,
  maxBytes = 960_000,
): void {
  if (
    !Number.isInteger(durationMs) ||
    durationMs < 250 ||
    durationMs > 30_000
  ) {
    throw new InvalidPcmError('PCM duration is outside the supported range');
  }
  if (pcm.byteLength === 0 || pcm.byteLength > maxBytes) {
    throw new InvalidPcmError('PCM byte count is outside the supported range');
  }
  if (pcm.byteLength % 2 !== 0) {
    throw new InvalidPcmError(
      'PCM must contain complete signed 16-bit samples',
    );
  }
  const expectedBytes = durationMs * (EVENHUB_BYTES_PER_SECOND / 1000);
  if (
    Math.abs(pcm.byteLength - expectedBytes) > EVENHUB_DURATION_TOLERANCE_BYTES
  ) {
    throw new InvalidPcmError('PCM byte count does not match its duration');
  }
}

export function createCanonicalWav(pcm: Uint8Array): Buffer {
  if (pcm.byteLength % 2 !== 0) {
    throw new InvalidPcmError(
      'PCM must contain complete signed 16-bit samples',
    );
  }

  const wav = Buffer.allocUnsafe(EVENHUB_WAV_HEADER_BYTES + pcm.byteLength);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + pcm.byteLength, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(EVENHUB_CHANNELS, 22);
  wav.writeUInt32LE(EVENHUB_SAMPLE_RATE, 24);
  wav.writeUInt32LE(EVENHUB_BYTES_PER_SECOND, 28);
  wav.writeUInt16LE(EVENHUB_CHANNELS * (EVENHUB_BITS_PER_SAMPLE / 8), 32);
  wav.writeUInt16LE(EVENHUB_BITS_PER_SAMPLE, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcm.byteLength, 40);
  Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).copy(
    wav,
    EVENHUB_WAV_HEADER_BYTES,
  );
  return wav;
}

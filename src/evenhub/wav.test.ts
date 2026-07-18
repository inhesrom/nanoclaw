import { describe, expect, it } from 'vitest';

import {
  createCanonicalWav,
  EVENHUB_WAV_HEADER_BYTES,
  InvalidPcmError,
  validateEvenHubPcm,
} from './wav.js';

describe('EvenHub PCM/WAV boundary', () => {
  it('wraps signed 16 kHz mono PCM in a canonical 44-byte WAV header', () => {
    const pcm = Buffer.from([0x34, 0x12, 0xcc, 0xff]);
    const wav = createCanonicalWav(pcm);

    expect(wav.subarray(0, 4).toString('ascii')).toBe('RIFF');
    expect(wav.readUInt32LE(4)).toBe(40);
    expect(wav.subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(wav.subarray(12, 16).toString('ascii')).toBe('fmt ');
    expect(wav.readUInt32LE(16)).toBe(16);
    expect(wav.readUInt16LE(20)).toBe(1);
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.readUInt32LE(28)).toBe(32_000);
    expect(wav.readUInt16LE(32)).toBe(2);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.subarray(36, 40).toString('ascii')).toBe('data');
    expect(wav.readUInt32LE(40)).toBe(pcm.byteLength);
    expect(wav.subarray(EVENHUB_WAV_HEADER_BYTES)).toEqual(pcm);
  });

  it('rejects malformed PCM and accepts one-frame duration tolerance', () => {
    expect(() => validateEvenHubPcm(new Uint8Array(7_360), 250)).not.toThrow();
    expect(() => validateEvenHubPcm(new Uint8Array(7_358), 250)).toThrow(
      InvalidPcmError,
    );
    expect(() => validateEvenHubPcm(new Uint8Array(8_001), 250)).toThrow(
      InvalidPcmError,
    );
    expect(() => validateEvenHubPcm(new Uint8Array(0), 250)).toThrow(
      InvalidPcmError,
    );
  });
});

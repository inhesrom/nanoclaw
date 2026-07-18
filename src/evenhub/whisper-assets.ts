import { createHash } from 'crypto';
import fs from 'fs';

export const WHISPER_CPP_VERSION = 'v1.9.1';
export const WHISPER_CPP_ARM64_SHA256 =
  'e0b66cd551ff6f2a28fabe3c6e89691eea037bb76833493abb9a71ca788994b3';
export const WHISPER_BASE_EN_SHA1 = '137c40403d78fd54d454da0f9bd998f78703390c';

export async function hashFile(
  filePath: string,
  algorithm: 'sha1' | 'sha256',
): Promise<string> {
  const hash = createHash(algorithm);
  await new Promise<void>((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    input.on('data', (chunk) => hash.update(chunk));
    input.once('error', reject);
    input.once('end', resolve);
  });
  return hash.digest('hex');
}

export async function verifyWhisperAssets(
  arm64ArchivePath: string,
  modelPath: string,
): Promise<void> {
  const [archiveDigest, modelDigest] = await Promise.all([
    hashFile(arm64ArchivePath, 'sha256'),
    hashFile(modelPath, 'sha1'),
  ]);
  if (archiveDigest !== WHISPER_CPP_ARM64_SHA256) {
    throw new Error('whisper.cpp arm64 archive checksum mismatch');
  }
  if (modelDigest !== WHISPER_BASE_EN_SHA1) {
    throw new Error('Whisper base.en model checksum mismatch');
  }
}

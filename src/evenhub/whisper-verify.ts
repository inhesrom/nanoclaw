import { verifyWhisperAssets, WHISPER_CPP_VERSION } from './whisper-assets.js';

async function main(): Promise<void> {
  const [, , archivePath, modelPath] = process.argv;
  if (!archivePath || !modelPath) {
    throw new Error(
      'Usage: npm run evenhub:whisper:verify -- <arm64-release.tar.gz> <ggml-base.en.bin>',
    );
  }
  await verifyWhisperAssets(archivePath, modelPath);
  process.stdout.write(
    `Verified whisper.cpp ${WHISPER_CPP_VERSION} arm64 and base.en checksums\n`,
  );
}

void main().catch((error) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : 'Whisper verification failed'}\n`,
  );
  process.exitCode = 1;
});

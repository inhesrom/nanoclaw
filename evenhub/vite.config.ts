import { defineConfig, loadEnv } from 'vite';

const APPROVED_ORIGIN = 'https://nanoclaw.local';

export default defineConfig(({ mode }) => {
  const configuredOrigin =
    process.env.VITE_EVENHUB_ORIGIN ||
    loadEnv(mode, process.cwd(), 'VITE_EVENHUB_ORIGIN').VITE_EVENHUB_ORIGIN ||
    APPROVED_ORIGIN;
  if (configuredOrigin !== APPROVED_ORIGIN) {
    throw new Error(`VITE_EVENHUB_ORIGIN must be ${APPROVED_ORIGIN}`);
  }

  return {
    server: {
      host: '0.0.0.0',
      port: 5173,
    },
  };
});

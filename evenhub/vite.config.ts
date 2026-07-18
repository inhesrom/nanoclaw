import { defineConfig, loadEnv } from 'vite';

function requireTailnetOrigin(value: string | undefined): string {
  if (!value) throw new Error('VITE_EVENHUB_ORIGIN is required');
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new Error(
      'VITE_EVENHUB_ORIGIN must be a canonical HTTPS ts.net origin',
      { cause: error },
    );
  }
  if (
    url.protocol !== 'https:' ||
    url.port !== '' ||
    url.origin !== value ||
    !url.hostname.endsWith('.ts.net') ||
    url.hostname.split('.').length < 4
  ) {
    throw new Error(
      'VITE_EVENHUB_ORIGIN must be a canonical HTTPS ts.net origin',
    );
  }
  return value;
}

export default defineConfig(({ mode }) => {
  const configuredOrigin = requireTailnetOrigin(
    process.env.VITE_EVENHUB_ORIGIN ||
      loadEnv('private', process.cwd(), 'EVENHUB_ORIGIN').EVENHUB_ORIGIN ||
      loadEnv(mode, process.cwd(), 'VITE_EVENHUB_ORIGIN').VITE_EVENHUB_ORIGIN,
  );

  return {
    define: {
      'import.meta.env.VITE_EVENHUB_ORIGIN': JSON.stringify(configuredOrigin),
    },
    server: {
      host: '0.0.0.0',
      port: 5173,
    },
  };
});

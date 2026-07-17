export interface WhisperTranscriber {
  transcribe(wav: Uint8Array): Promise<string>;
}

export class WhisperClientError extends Error {
  constructor(
    readonly code: 'invalid_audio' | 'stt_unavailable',
    readonly retryable: boolean,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'WhisperClientError';
  }
}

export interface WhisperClientOptions {
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class WhisperClient implements WhisperTranscriber {
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(
    private readonly endpoint: string,
    options: WhisperClientOptions = {},
  ) {
    const endpointUrl = new URL(endpoint);
    if (
      endpointUrl.protocol !== 'http:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(endpointUrl.hostname) ||
      endpointUrl.username ||
      endpointUrl.password
    ) {
      throw new Error(
        'Whisper endpoint must be an unauthenticated loopback URL',
      );
    }
    this.fetchImpl = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  async transcribe(wav: Uint8Array): Promise<string> {
    const body = new FormData();
    body.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    body.append('response_format', 'json');
    body.append('temperature', '0.0');
    body.append('prompt', '');
    body.append('carry_initial_prompt', 'false');
    body.append('language', 'en');

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      throw new WhisperClientError(
        'stt_unavailable',
        true,
        'Local speech recognition is unavailable',
      );
    }

    if (!response.ok) {
      const retryable = response.status >= 500;
      throw new WhisperClientError(
        retryable ? 'stt_unavailable' : 'invalid_audio',
        retryable,
        retryable
          ? 'Local speech recognition is unavailable'
          : 'Local speech recognition rejected the recording',
        response.status,
      );
    }

    try {
      const payload = (await response.json()) as { text?: unknown };
      if (typeof payload.text !== 'string') throw new Error('missing text');
      return normalizeTranscript(payload.text);
    } catch {
      throw new WhisperClientError(
        'stt_unavailable',
        true,
        'Local speech recognition returned an invalid response',
        response.status,
      );
    }
  }
}

export function normalizeTranscript(transcript: string): string {
  return transcript.trim().replace(/\s+/gu, ' ');
}

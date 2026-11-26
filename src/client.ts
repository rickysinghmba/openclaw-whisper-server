/**
 * Client for a resident whisper.cpp server (`whisper-server` from whisper.cpp's examples/server).
 *
 * The server keeps one model loaded and transcribes one request at a time behind a mutex. This client
 * only talks to it over loopback, waits for at most `maxQueuedRequests` requests behind the active one,
 * and never falls back to any other service.
 */

export type WhisperServerSettings = {
  baseUrl: string;
  inferencePath: string;
  model: string;
  maxQueuedRequests: number;
  temperature: number;
};

export type TranscribeInput = {
  buffer: Uint8Array;
  fileName: string;
  mime?: string;
  language?: string;
  prompt?: string;
  timeoutMs: number;
  signal?: AbortSignal;
};

export type TranscribeOutput = { text: string; model: string };

type FetchFn = typeof fetch;

export const DEFAULT_SETTINGS: WhisperServerSettings = {
  baseUrl: "http://127.0.0.1:8080",
  inferencePath: "/inference",
  model: "whisper.cpp",
  maxQueuedRequests: 4,
  temperature: 0,
};

export class WhisperServerError extends Error {
  readonly code: "not-loopback" | "unreachable" | "loading" | "queue-full" | "server-error" | "bad-response";

  constructor(code: WhisperServerError["code"], message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WhisperServerError";
    this.code = code;
  }
}

/** Merges plugin config over the defaults, keeping only known keys of the right type. */
export function resolveSettings(config: unknown): WhisperServerSettings {
  const raw = config && typeof config === "object" ? (config as Record<string, unknown>) : {};
  const text = (key: keyof WhisperServerSettings) =>
    typeof raw[key] === "string" && raw[key] ? (raw[key] as string) : (DEFAULT_SETTINGS[key] as string);
  const queued = raw.maxQueuedRequests;
  const temperature = raw.temperature;
  return {
    baseUrl: text("baseUrl"),
    inferencePath: text("inferencePath"),
    model: text("model"),
    maxQueuedRequests:
      typeof queued === "number" && Number.isInteger(queued) && queued >= 0 && queued <= 32
        ? queued
        : DEFAULT_SETTINGS.maxQueuedRequests,
    temperature:
      typeof temperature === "number" && temperature >= 0 && temperature <= 1
        ? temperature
        : DEFAULT_SETTINGS.temperature,
  };
}

/** True for localhost, 127.0.0.0/8 and ::1. */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const parts = host.split(".");
  return (
    parts.length === 4 &&
    parts[0] === "127" &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  );
}

/** Parses the base URL and refuses anything that isn't plain HTTP(S) on a loopback host. */
export function loopbackBaseUrl(baseUrl: string): URL {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch (cause) {
    throw new WhisperServerError("not-loopback", `whisper-server baseUrl isn't a valid URL: ${baseUrl}`, { cause });
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || !isLoopbackHost(url.hostname)) {
    throw new WhisperServerError(
      "not-loopback",
      `whisper-server only connects to a server on this machine (localhost, 127.0.0.1 or ::1), not ${url.host}.`,
    );
  }
  return url;
}

function endpoint(base: URL, path: string): URL {
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
  return url;
}

/**
 * Reports whether the server answers `GET /health` with `{"status":"ok"}`. The server returns 503 while
 * it loads the model, so a loading server reads as not ready.
 */
export async function checkHealth(
  settings: WhisperServerSettings,
  options: { fetchFn?: FetchFn; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<"ok" | "loading" | "unreachable"> {
  const base = loopbackBaseUrl(settings.baseUrl);
  const signals = [AbortSignal.timeout(options.timeoutMs ?? 2_000)];
  if (options.signal) signals.push(options.signal);
  try {
    const response = await (options.fetchFn ?? fetch)(endpoint(base, "/health"), {
      signal: AbortSignal.any(signals),
    });
    const body = (await response.json().catch(() => null)) as { status?: unknown } | null;
    if (response.ok && body?.status === "ok") return "ok";
    if (response.status === 503) return "loading";
    return "unreachable";
  } catch {
    options.signal?.throwIfAborted();
    return "unreachable";
  }
}

/**
 * Admits one active request plus a bounded number of waiters. The server transcribes one request at a
 * time, so sending more in parallel only makes them wait inside the server where they can't be bounded.
 */
export class RequestQueue {
  #active = false;
  #waiters: Array<() => void> = [];
  readonly maxQueued: number;

  constructor(maxQueued: number) {
    this.maxQueued = maxQueued;
  }

  get pending(): number {
    return this.#waiters.length + (this.#active ? 1 : 0);
  }

  async run<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
    if (this.#active) {
      if (this.#waiters.length >= this.maxQueued) {
        throw new WhisperServerError(
          "queue-full",
          `whisper-server is busy: ${this.maxQueued} requests are already waiting. Try again shortly.`,
        );
      }
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          this.#waiters = this.#waiters.filter((waiter) => waiter !== wake);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        this.#waiters.push(wake);
      });
    }
    this.#active = true;
    try {
      signal.throwIfAborted();
      return await task();
    } finally {
      this.#active = false;
      this.#waiters.shift()?.();
    }
  }
}

/**
 * Sends one audio file to `POST <inferencePath>` and returns the transcript. The deadline covers both
 * waiting in the queue and the transcription itself. Every failure throws: per OpenClaw's media
 * provider contract, a failed upload must stop automatic selection rather than try another provider.
 */
export async function transcribe(
  settings: WhisperServerSettings,
  queue: RequestQueue,
  input: TranscribeInput,
  fetchFn: FetchFn = fetch,
): Promise<TranscribeOutput> {
  const base = loopbackBaseUrl(settings.baseUrl);
  const signals = [AbortSignal.timeout(input.timeoutMs)];
  if (input.signal) signals.push(input.signal);
  const signal = AbortSignal.any(signals);

  return queue.run(signal, async () => {
    const health = await checkHealth(settings, { fetchFn, signal });
    if (health === "loading") {
      throw new WhisperServerError("loading", "whisper-server is still loading its model. Try again shortly.");
    }
    if (health === "unreachable") {
      throw new WhisperServerError(
        "unreachable",
        `Couldn't reach whisper-server at ${base.origin}. Check that it's running.`,
      );
    }

    const form = new FormData();
    form.append(
      "file",
      // Copy into a plain ArrayBuffer: a Node Buffer may sit on shared memory, which Blob refuses.
      new Blob([new Uint8Array(input.buffer)], { type: input.mime ?? "application/octet-stream" }),
      input.fileName,
    );
    form.append("response_format", "json");
    form.append("temperature", String(settings.temperature));
    if (input.language) form.append("language", input.language);
    if (input.prompt) form.append("prompt", input.prompt);

    let response: Response;
    try {
      response = await fetchFn(endpoint(base, settings.inferencePath), { method: "POST", body: form, signal });
    } catch (cause) {
      signal.throwIfAborted();
      throw new WhisperServerError("unreachable", `Couldn't reach whisper-server at ${base.origin}.`, { cause });
    }
    const body = (await response.json().catch(() => null)) as { text?: unknown; error?: unknown } | null;
    if (!response.ok) {
      const detail = typeof body?.error === "string" ? body.error : `HTTP ${response.status}`;
      throw new WhisperServerError("server-error", `whisper-server couldn't transcribe the audio: ${detail}`);
    }
    if (typeof body?.text !== "string") {
      throw new WhisperServerError("bad-response", "whisper-server returned no transcript.");
    }
    // The server puts each decoded segment on its own line; join them into running text.
    return { text: body.text.replace(/\s*\n\s*/g, " ").trim(), model: settings.model };
  });
}

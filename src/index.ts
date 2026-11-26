import type { MediaUnderstandingProvider } from "openclaw/plugin-sdk/media-understanding";
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { checkHealth, RequestQueue, resolveSettings, transcribe } from "./client.ts";

const PROVIDER_ID = "whisper-server";

export function createWhisperServerProvider(pluginConfig: unknown): MediaUnderstandingProvider {
  const settings = resolveSettings(pluginConfig);
  // One queue per registration: the server transcribes one request at a time.
  const queue = new RequestQueue(settings.maxQueuedRequests);
  // A tools.media.models entry may point at another loopback server; it is validated the same way.
  const withEntry = (baseUrl?: string) => (baseUrl ? { ...settings, baseUrl } : settings);

  return {
    id: PROVIDER_ID,
    capabilities: ["audio"],
    defaultModels: { audio: settings.model },
    resolveAuth: () => ({ kind: "none", source: "whisper-server plugin: local server, no credentials" }),
    isAudioConfigured: async (context) => (await checkHealth(withEntry(context.baseUrl))) === "ok",
    transcribeAudio: (req) =>
      transcribe(
        withEntry(req.baseUrl),
        queue,
        {
          buffer: req.buffer,
          fileName: req.fileName,
          mime: req.mime,
          language: req.language,
          prompt: req.prompt,
          timeoutMs: req.timeoutMs,
          signal: req.signal,
        },
        req.fetchFn,
      ),
  };
}

export default definePluginEntry({
  id: PROVIDER_ID,
  name: "whisper.cpp Server",
  description: "Transcribes audio locally through a resident whisper.cpp server.",
  register(api) {
    api.registerMediaUnderstandingProvider(createWhisperServerProvider(api.pluginConfig));
  },
});

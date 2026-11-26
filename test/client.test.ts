import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import {
  checkHealth,
  isLoopbackHost,
  loopbackBaseUrl,
  RequestQueue,
  resolveSettings,
  transcribe,
  WhisperServerError,
} from "../src/client.ts";

type FakeOptions = {
  health?: "ok" | "loading";
  delayMs?: number;
  status?: number;
  body?: unknown;
  hang?: boolean;
};

/** A stand-in for whisper.cpp's examples/server: GET /health, POST /inference, one request at a time. */
async function fakeWhisperServer(t: { after: (fn: () => unknown) => void }, options: FakeOptions = {}) {
  const seen: Array<{ path: string; body: string }> = [];
  let active = 0;
  let maxActive = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("latin1");
    seen.push({ path: req.url ?? "", body });
    res.setHeader("content-type", "application/json");
    if (req.method === "GET" && req.url === "/health") {
      if (options.health === "loading") {
        res.statusCode = 503;
        res.end('{"status":"loading model"}');
      } else res.end('{"status":"ok"}');
      return;
    }
    if (req.method === "POST" && req.url === "/inference") {
      if (options.hang) return;
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 0));
      active--;
      res.statusCode = options.status ?? 200;
      res.end(JSON.stringify(options.body ?? { text: " Hello from whisper.\n" }));
      return;
    }
    res.statusCode = 404;
    res.end('{"error":"not found"}');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  return {
    settings: resolveSettings({ baseUrl: `http://127.0.0.1:${port}`, model: "ggml-base.en" }),
    seen,
    maxActive: () => maxActive,
    inferenceCalls: () => seen.filter((s) => s.path === "/inference").length,
  };
}

const audio = { buffer: new Uint8Array([82, 73, 70, 70]), fileName: "voice.ogg", mime: "audio/ogg", timeoutMs: 5_000 };

test("only loopback hosts are accepted", () => {
  for (const host of ["localhost", "127.0.0.1", "127.8.9.10", "::1", "[::1]"]) assert.equal(isLoopbackHost(host), true, host);
  for (const host of ["192.168.1.5", "10.0.0.1", "example.com", "127.0.0.256", "0.0.0.0", "127.0.0.1.example.com"]) {
    assert.equal(isLoopbackHost(host), false, host);
  }
  assert.throws(() => loopbackBaseUrl("http://192.168.1.5:8080"), { code: "not-loopback" });
  assert.throws(() => loopbackBaseUrl("file:///tmp/x"), { code: "not-loopback" });
  assert.throws(() => loopbackBaseUrl("not a url"), { code: "not-loopback" });
  assert.equal(loopbackBaseUrl("http://localhost:8080").port, "8080");
});

test("settings fall back to defaults for missing or invalid values", () => {
  assert.deepEqual(resolveSettings(undefined), {
    baseUrl: "http://127.0.0.1:8080",
    inferencePath: "/inference",
    model: "whisper.cpp",
    maxQueuedRequests: 4,
    temperature: 0,
  });
  const s = resolveSettings({ maxQueuedRequests: 99, temperature: 3, model: "", baseUrl: 5 });
  assert.equal(s.maxQueuedRequests, 4);
  assert.equal(s.temperature, 0);
  assert.equal(s.model, "whisper.cpp");
  assert.equal(s.baseUrl, "http://127.0.0.1:8080");
});

test("transcribes through /inference and returns the trimmed text with the model label", async (t) => {
  const fake = await fakeWhisperServer(t);
  const result = await transcribe(fake.settings, new RequestQueue(4), { ...audio, language: "en", prompt: "names: Ada" });
  assert.deepEqual(result, { text: "Hello from whisper.", model: "ggml-base.en" });
  const upload = fake.seen.find((s) => s.path === "/inference");
  assert.ok(upload, "posted to /inference");
  assert.match(upload.body, /name="file"; filename="voice\.ogg"/);
  assert.match(upload.body, /name="response_format"\r\n\r\njson/);
  assert.match(upload.body, /name="language"\r\n\r\nen/);
  assert.match(upload.body, /name="prompt"\r\n\r\nnames: Ada/);
});

test("health reports ok, loading and unreachable", async (t) => {
  assert.equal(await checkHealth((await fakeWhisperServer(t)).settings), "ok");
  assert.equal(await checkHealth((await fakeWhisperServer(t, { health: "loading" })).settings), "loading");
  assert.equal(await checkHealth(resolveSettings({ baseUrl: "http://127.0.0.1:1" })), "unreachable");
});

test("a server still loading its model is refused before any audio is sent", async (t) => {
  const fake = await fakeWhisperServer(t, { health: "loading" });
  await assert.rejects(transcribe(fake.settings, new RequestQueue(4), audio), { code: "loading" });
  assert.equal(fake.inferenceCalls(), 0);
});

test("an unreachable server throws instead of falling back", async () => {
  await assert.rejects(
    transcribe(resolveSettings({ baseUrl: "http://127.0.0.1:1" }), new RequestQueue(4), audio),
    { code: "unreachable" },
  );
});

test("server errors carry the server's message", async (t) => {
  const fake = await fakeWhisperServer(t, { status: 400, body: { error: "failed to read audio data as wav" } });
  await assert.rejects(transcribe(fake.settings, new RequestQueue(4), audio), (error: unknown) => {
    assert.ok(error instanceof WhisperServerError);
    assert.equal(error.code, "server-error");
    assert.match(error.message, /failed to read audio data as wav/);
    return true;
  });
});

test("a response without text is rejected", async (t) => {
  const fake = await fakeWhisperServer(t, { body: { nope: true } });
  await assert.rejects(transcribe(fake.settings, new RequestQueue(4), audio), { code: "bad-response" });
});

test("requests run one at a time and the queue refuses beyond its bound", async (t) => {
  const fake = await fakeWhisperServer(t, { delayMs: 150 });
  const queue = new RequestQueue(1);
  const results = await Promise.allSettled([
    transcribe(fake.settings, queue, audio),
    transcribe(fake.settings, queue, audio),
    transcribe(fake.settings, queue, audio),
  ]);
  assert.deepEqual(
    results.map((r) => r.status),
    ["fulfilled", "fulfilled", "rejected"],
  );
  assert.equal((results[2] as PromiseRejectedResult).reason.code, "queue-full");
  assert.equal(fake.maxActive(), 1, "the server never saw two transcriptions at once");
  assert.equal(queue.pending, 0);
});

test("the deadline covers queue wait and transcription, and frees the queue", async (t) => {
  const fake = await fakeWhisperServer(t, { hang: true });
  const queue = new RequestQueue(4);
  const started = Date.now();
  const results = await Promise.allSettled([
    transcribe(fake.settings, queue, { ...audio, timeoutMs: 300 }),
    transcribe(fake.settings, queue, { ...audio, timeoutMs: 300 }),
  ]);
  assert.deepEqual(results.map((r) => r.status), ["rejected", "rejected"]);
  for (const r of results) assert.equal((r as PromiseRejectedResult).reason.name, "TimeoutError");
  assert.ok(Date.now() - started < 2_000, "both requests gave up near their deadline");
  assert.equal(queue.pending, 0, "the queue is empty afterwards");
});

test("a caller's abort cancels the request", async (t) => {
  const fake = await fakeWhisperServer(t, { hang: true });
  const controller = new AbortController();
  const pending = transcribe(fake.settings, new RequestQueue(4), { ...audio, signal: controller.signal });
  setTimeout(() => controller.abort(new Error("caller cancelled")), 100);
  await assert.rejects(pending, /caller cancelled/);
});

# openclaw-whisper-server

Local audio transcription for [OpenClaw](https://openclaw.ai) through a resident
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) server. The model stays loaded between
voice messages, so each transcription skips the model load.

OpenClaw can already run `whisper-cli` locally, but it starts a new process and loads the model
for every message. This plugin connects OpenClaw to a `whisper-server` you keep running instead.
Audio never leaves your machine, and there's no cloud fallback.

> **Status: 0.1, early.** Tested on macOS (Apple Silicon) with OpenClaw 2026.11.10 and whisper.cpp
> v1.9.6: installed from the packed npm tarball and transcribed a WAV file end to end through
> `openclaw infer audio transcribe`. Compressed voice notes (which need the server's `--convert` and
> `ffmpeg`), Linux, and Gateway Talk haven't been tested yet. Please report what you find.

## Requirements

- OpenClaw 2026.11.10 or later
- A whisper.cpp build that includes `whisper-server`. The Homebrew `whisper-cpp` package doesn't
  include the server, so build whisper.cpp from source.
- `ffmpeg` on your `PATH`, so the server can convert voice notes (OGG/Opus, M4A, MP3) to WAV

## Set up whisper.cpp

Build whisper.cpp and download a model:

```bash
git clone https://github.com/ggml-org/whisper.cpp
cd whisper.cpp
cmake -B build
cmake --build build -j --config Release
sh ./models/download-ggml-model.sh base.en
```

Start the server on loopback with audio conversion turned on:

```bash
./build/bin/whisper-server -m models/ggml-base.en.bin --host 127.0.0.1 --port 8080 --convert
```

Check that it's ready. While the model loads, this returns `{"status":"loading model"}`:

```bash
curl http://127.0.0.1:8080/health
```

Keep the server running, for example with a launchd agent on macOS or a systemd user service on
Linux.

## Install the plugin

```bash
openclaw plugins install openclaw-whisper-server --accept-capabilities
```

`--accept-capabilities` consents to the plugin registering an audio transcription provider.

Try it on a file:

```bash
openclaw infer audio transcribe --file ./memo.wav --model whisper-server/whisper.cpp --json
```

To use it for incoming voice messages, select it for audio in your OpenClaw config:

```json5
{
  tools: {
    media: {
      models: [{ provider: "whisper-server", capabilities: ["audio"] }],
    },
  },
}
```

## Configuration

Settings go under `plugins.entries.whisper-server.config`. All are optional.

| Setting             | Default                 | What it does                                                                                         |
| ------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------- |
| `baseUrl`           | `http://127.0.0.1:8080` | Address of the server. Only `localhost`, `127.0.0.0/8` and `::1` are accepted.                       |
| `inferencePath`     | `/inference`            | Must match the server's `--inference-path`.                                                          |
| `model`             | `whisper.cpp`           | Label OpenClaw shows as the transcription model, such as `ggml-base.en`. The server picks the model. |
| `maxQueuedRequests` | `4`                     | How many requests can wait while one is transcribing. Requests beyond that are refused.              |
| `temperature`       | `0`                     | Decoding temperature sent with each request.                                                         |

## How it behaves

- **Loopback only.** The plugin refuses any server address that isn't on this machine. The
  whisper.cpp server accepts file uploads and runs `ffmpeg`, so don't expose it to a network.
- **Health first.** Before sending audio, the plugin checks `GET /health`. If the server is down or
  still loading its model, the request fails without uploading anything.
- **One at a time.** The server transcribes one request at a time. The plugin queues up to
  `maxQueuedRequests` more and refuses the rest, instead of piling them up inside the server.
- **Deadlines.** OpenClaw's timeout covers waiting in the queue and the transcription itself.
  Cancelled requests leave the queue straight away.
- **No fallback.** If transcription fails, the error goes back to OpenClaw. The plugin never sends
  audio anywhere else.

## Development

```bash
npm install --legacy-peer-deps
npm test
npm run build
```

`--legacy-peer-deps` skips installing the `openclaw` peer package, which only the entry file's
types need.

## License

MIT

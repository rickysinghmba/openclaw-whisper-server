# Changelog

Notable changes to this project. Versions follow [semantic versioning](https://semver.org).

## 0.1.2 - 2026-11-27

- Clearer name and description so the plugin can be found by searching for speech-to-text, STT,
  voice messages or offline transcription. No behaviour changes.
- README adds badges and links to the roadmap.

## 0.1.1 - 2026-11-26

- Supports OpenClaw 2026.10.34 and later (tested on 2026.10.34, 2026.11.9 and 2026.11.10).
- Adds the plugin icon.

## 0.1.0 - 2026-11-26

- First release: audio transcription through a resident whisper.cpp server on loopback, with a
  health check before each upload, a bounded request queue, deadlines, and no cloud fallback.

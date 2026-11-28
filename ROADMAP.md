# Roadmap

Plans, not promises. Order can change with feedback, so please open an issue if something here
matters to you or is missing.

## Now: trust

- Test on Linux and run the tests in CI on every change.
- Add `SECURITY.md` and `CHANGELOG.md`.

## Next: 0.2

- Verify Gateway Talk (live voice) and fix what breaks.
- Test the setup skill's service templates end to end. The launchd one is based on an agent
  that runs on macOS; the systemd one is untested.

## Later

- Choose a model per language, for people who speak more than one.
- Voice notes over XMPP with
  [@rickysinghmba/openclaw-xmpp](https://github.com/rickysinghmba/openclaw-xmpp), for a voice
  assistant that runs entirely on your own machines.

## Not planned

- Remote servers. The plugin only talks to a whisper.cpp server on the same machine.
- Cloud fallback. If local transcription fails, the error is reported and audio goes nowhere else.

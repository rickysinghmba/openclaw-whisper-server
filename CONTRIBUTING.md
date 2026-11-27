# Contributing

Thanks for helping. Bug reports, test results on other setups, and small focused changes are all
welcome.

## Reporting a bug

Open an issue with the bug report form. The versions and the relevant log lines save a round of
questions. Remove passwords, tokens and private addresses from anything you paste.

For a security problem, don't open a public issue. See [SECURITY.md](SECURITY.md).

## Making a change

```bash
npm install --legacy-peer-deps
npm test
```

`npm test` runs the tests against a fake whisper.cpp server, so you don't need whisper.cpp installed to run them.

- Keep a pull request to one change, and add or update a test for it.
- Keep the plugin loopback-only and without any cloud fallback. Changes to those two rules won't be accepted.
- Update `README.md` when behaviour or settings change, and add a line to `CHANGELOG.md`.
- For anything larger than a bug fix, open an issue first so we can agree on the approach. The
  [roadmap](ROADMAP.md) shows what is planned.

## Using AI tools

AI-assisted changes are fine. Say so in the pull request, and only send code you have run and
understand.

## Conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md).

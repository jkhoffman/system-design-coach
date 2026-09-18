# Recording the README demo

The demo drives the actual production UI with Playwright. Interview responses,
grades, and audio come from local mocks; an OpenAI key is neither required nor used.
Every run starts a fresh database and provider on isolated local ports, then removes
the database and stops the browser and servers on completion or failure.

## Run locally

Use Node 22.18 or newer, install dependencies with `npm ci`, and install Chromium:

```bash
npx playwright install chromium
# macOS: brew install ffmpeg
# Ubuntu: sudo apt-get install ffmpeg
npm run demo:record
```

Both `ffmpeg` and `ffprobe` must be on PATH. The command builds with Webpack and
replaces `docs/demo.gif` only after the walkthrough and media checks pass. When a
production build already exists, use `npm run demo:record -- --skip-build`.
Use only one recorder/build at a time in a checkout.

The GIF is a silent, looping 960×600 animation at 12 fps, captured from a 1280×800
browser with an English locale, UTC timezone, and dark theme. The walkthrough targets
30–40 seconds. Generation fails above 45 seconds or 5 MiB instead of truncating
the demonstration. `artifacts/demo/` contains the raw video, scene screenshots,
validated GIF, and timing metadata. It is ignored by Git and replaced on each run.

## Maintain the walkthrough

`scripts/record-demo.mjs` owns five named scenes: setup, interview, board response,
scorecard, and replay. They select the URL-shortener prompt, draw Client → API →
Database, receive a whiteboard follow-up, end the interview, and review the result.

UI changes appear automatically when the same scenes run against the new app.
To feature new functionality, update the scenes in the feature's change. Use
accessible role/text selectors, wait for observable UI or saved state, and reserve
fixed pauses for reading. Keep the total timing within the budget. Edit
`scripts/demo-fixtures.mjs` alongside the scenes so the simulated transcript,
scorecard, and board stay consistent. The demo's longer synthetic WAV supports
seeking; it does not contain the simulated dialogue. Existing regression-test
fixtures retain their defaults.

Inspect the generated loop and scene screenshots before publishing. A failed run
keeps the previously published GIF and writes `failure.txt`, a screenshot when
available, and the captured video to the artifact directory. Server logs are included
in the failure report.

```bash
# Requires an existing production build; deliberately fails after recording.
# Asserts the old GIF is unchanged, temporary data is gone, and both servers stopped.
npm run demo:check-failure
```

## Automatic updates

The **Update README demo** workflow runs after relevant source, asset, dependency,
mock/recorder, and build configuration changes land on `main`. It can also be run
manually from GitHub Actions on `main`. It installs Node 22, Chromium and FFmpeg,
runs lint, type checking, deterministic tests and mock browser tests, verifies the
failure path, then records the demo. It builds the app only once.

The workflow maintains one PR from `codex/update-demo` into `main`, containing only
`docs/demo.gif`. Its description includes the preview, source commit, duration,
size, and workflow link. Review and merge this PR normally. Generated-GIF and
README-only changes are excluded from the trigger, so the merge does not create
an update loop. A newer run cancels an older run. Recording artifacts are retained
for 14 days, including on failure; failed recordings do not publish changes.

The repository must enable **Settings → Actions → General → Allow GitHub Actions
to create and approve pull requests**. Default workflow permissions remain
read-only; only this job requests `contents: write` and `pull-requests: write`.
It uses `GITHUB_TOKEN` without personal tokens or API secrets and never auto-merges.
GitHub does not generally start additional workflows for changes made using this
token, so validation happens in the recording workflow before the PR is created.

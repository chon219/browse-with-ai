# Development

[Overview](../README.md) · [Architecture](architecture.md)

## Setup

Use Node.js 22+ and npm.

```sh
npm ci
npm run build
```

Load `dist/` as an unpacked extension from `chrome://extensions`. Rebuild and reload the extension after source changes.

The icon source is `public/icons/bwai.svg`. After editing it, run `npm run icons` to regenerate the PNG sizes using Playwright Chromium.

## Checks

```sh
npm run check
npm test
npx playwright install chromium
npm run test:e2e
```

- `check` type-checks application and test code.
- `test` runs Vitest tests for agent execution, persistence, browser rules, documents, and UI helpers.
- `test:e2e` builds the extension and runs Playwright against an isolated Chromium profile with fixture websites and model responses.

Run a single browser suite after building:

```sh
npx playwright test tests/e2e/conversation.spec.ts
```

Test artifacts are saved in `test-results/`. Shared fixtures live in `tests/fixtures/` and browser helpers in `tests/e2e/support/`.

To include the live website test in PowerShell:

```powershell
$env:BWAI_LIVE_BROWSER = '1'
npx playwright test -g 'live public website'
```

## Debugging

Enable **Settings → Debug logs** to record model requests, tool results, and execution events. Inspect `[BWAI debug]` entries in the task page console, or export and clear logs from settings.

For an end-to-end manual check, configure a model, attach a page, complete a task, review an action confirmation, and download its output.

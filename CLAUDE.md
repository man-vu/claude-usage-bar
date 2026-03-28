# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VS Code extension that monitors Claude Code rate limits, API-equivalent costs, and token usage. Displays a status bar item with utilization percentage and a rich HTML tooltip, plus a full webview analytics dashboard (charts, heatmaps, model/project breakdowns).

## Build & Development Commands

```bash
npm run compile        # TypeScript → out/
npm run watch          # Incremental recompile on save
npm run lint           # ESLint (src/**/*.ts)
npm run package        # Build .vsix for distribution
```

No test framework is configured — there are no unit tests.

To test the extension: press F5 in VS Code to launch the Extension Development Host.

## Architecture

Six source files in `src/`, no frameworks beyond the VS Code API and Node built-ins:

- **extension.ts** — Entry point (`activate`/`deactivate`). Orchestrates refresh cycles, builds the unified tooltip (rich MarkdownString with HTML/CSS), manages timers with exponential backoff for 429s. Caches API data in `globalState` across sessions.
- **api.ts** — Single HTTPS GET to `api.anthropic.com/api/oauth/usage` using Node's built-in `https` module (zero dependencies). Returns `UsageData` with `five_hour`, `seven_day`, `seven_day_opus` utilization buckets.
- **credentials.ts** — Reads Claude Code OAuth tokens. On macOS tries Keychain first (`security find-generic-password`), then falls back to `~/.claude/.credentials.json` (used on Windows/Linux).
- **scanner.ts** — Scans `~/.claude/projects/*/*.jsonl` conversation files to compute `DailyStats`: cost (using hardcoded API pricing per model), tokens, tool usage, hourly activity, project/model breakdowns. Streams files via `readline` with a 3s timeout per file.
- **statusBar.ts** — `StatusBarManager` class wrapping a single `vscode.StatusBarItem`. Handles visual states (loading, error, rate-limited, no-credentials) and color thresholds.
- **dashboard.ts** — `DashboardPanel` singleton managing a webview panel. `buildHtml()` generates a self-contained HTML page with inline CSS/JS (Canvas charts, donut charts, heatmaps, period filtering). This is the largest file (~1200 lines).

## Key Design Decisions

- **Zero external runtime dependencies** — only `@types/node`, `@types/vscode`, and `typescript` as devDeps. The API client uses raw `https.request`.
- **All cost/token data is local** — computed by scanning JSONL files on disk, never sent anywhere. The only network call is the OAuth usage endpoint for rate limits.
- **Model pricing is hardcoded** in `scanner.ts` (`MODEL_PRICING` constant) — must be updated manually when Anthropic changes pricing or adds models.
- **Dashboard is a single HTML string** — no bundler, no separate HTML/CSS/JS files. The entire dashboard UI is built by string concatenation in `dashboard.ts:buildHtml()`.
- **Tooltip is rich Markdown** — uses `MarkdownString` with `supportHtml = true` for colored bars and tables in the status bar hover.

## Configuration

Extension settings are defined in `package.json` under `contributes.configuration` with the prefix `claudeUsageBar.*` (refreshInterval, warningThreshold, criticalThreshold, showInStatusBar, dailyBudget).

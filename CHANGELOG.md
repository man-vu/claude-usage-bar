# Changelog

## 0.4.3

- Context View: workspace scoping fixed — paths with dots, underscores, or other
  special characters (e.g. `my-site.github.io`) now match their Claude Code
  project directory instead of silently showing another project's session
- Context View: shows an honest "no session for this workspace" state instead of
  falling back to unrelated sessions
- Context window sizes updated for current models (Fable 5 at 1M) with a
  ground-truth guard so usage can never display above 100%, even for models
  released after this version
- Deferred MCP tools no longer overcounted (~20x) in the context breakdown
- Pricing table refreshed to current published API rates and extended with
  Fable 5, Mythos 5, Opus 4.7, Opus 4.8, and Sonnet 5
- Model names display generically ("Fable 5", "Opus 4.8") for any model id
- Fixed grid rendering dropping free-space and buffer squares

## 0.1.0

- Initial release
- Status bar with visual usage bar and percentage
- Color-coded alerts (green/yellow/red)
- 5-hour and 7-day limit tracking with reset countdowns
- Auto-refresh with configurable interval
- Cross-platform credential reading (Windows, macOS, Linux)

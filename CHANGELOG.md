# Changelog

All notable changes to this project are documented here.

This changelog is intentionally sanitized. Historical operational entries that contained private deployment names, local paths, personal references, or environment-specific identifiers were removed from the public file. Use private deployment notes for environment-specific history.

---

## Unreleased

- Added callback-query support for inline Telegram buttons in the bridge: `getUpdates` now accepts `callback_query`, taps are acknowledged via `answerCallbackQuery`, and allowed taps are delivered to the agent as synthetic `[button] <callback_data>` messages.
- Added fleet/quick-reply button helpers: one-message inline reply buttons for worker addressing and one-time lower keyboards for discrete quick replies, both optional and backward-compatible.
- Added local `POST /inject-mirror` endpoint: the task scheduler mirrors each injected cron/registry task to the bot owner's Telegram chat (copy marker, truncated, plain text, fire-and-forget), so the owner sees when an agent picks up work. Registry pickups mirror the actual claimable task titles instead of the generic claim prompt; deterministic script probes are not mirrored. Bot tokens stay inside the bridge.
- Live-status watcher now skips the render+POST tick when the agent log has not advanced (size:mtime change-detection), eliminating the idle-time renderer storm that pinned host CPU; verbose updates still fire the instant the log grows. Watcher also self-terminates when its log is removed, preventing orphan watchers across restarts.
- Documentation now focuses only on the agent-to-MCP bridge contract.
- Removed private deployment procedure details from committed instructions.
- Sanitized docs and package metadata to use placeholders only.

## v3.3.3

- Added document attachment support for bridge-mediated Telegram replies.
- Hardened live-status edits so arbitrary rendered CLI text does not break Telegram formatting.

## v3.3.2

- Documented renderer runtime dependency for live status updates.
- Added fail-loud watcher diagnostics when rendering fails.

## v3.3.1

- Added auto-compact gating for high-context sessions.
- Added scoped permission forwarding by bot identity.
- Improved launcher compatibility and runtime restart documentation.

## v3.2.0

- Added generic slash-command passthrough with guards.
- Added group-chat access gating for passthrough commands.
- Documented command-safety invariants.

## v3.1.x

- Improved live status streaming, rendering stability, status lifecycle, and cross-bot isolation.
- Added command forwarding for status/compact/stop style operations.
- Improved TUI rendering and reduced noisy status output.

# Changelog

All notable changes to this project are documented here.

This changelog is intentionally sanitized. Historical operational entries that contained private deployment names, local paths, personal references, or environment-specific identifiers were removed from the public file. Use private deployment notes for environment-specific history.

---

## Unreleased

- Documentation now describes the hardened bridge flow generically: shared MCP/SSE bridge, agent isolation boundary, wake-on-message, duplicate-session cleanup, bridge-side media transcription, and live status rendering.
- Sanitized public docs and package metadata to avoid real deployment paths, private hostnames, personal contact details, bot identities, user/chat IDs, and token examples. Use placeholders only.

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

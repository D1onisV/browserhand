# Changelog

## 0.3.1

- Updating on Windows uses the system's own `tar`, so a GNU tar from Git in PATH no longer breaks unpacking.
- After an update the extension reloads itself as intended (the "updated" signal was being dropped). If you update from 0.3.0, reload the extension once on the extensions page.

## 0.3.0

- Releases: every version is published on GitHub as **browserhand.zip**; the link to the latest release never changes.
- One-click updates: the extension checks for a new release once a day and offers **Update** in the menu ⋯. The host downloads it, replaces the files and keeps your chats, settings and media tools.
- `node host/bh.js update` and `node host/update.js` update from the terminal.

## 0.2.0

- No more "debugging this browser" bar during normal work. Trusted mouse and keyboard input is now the **Real click and keyboard** setting, off by default; clicks, typing and keys use page events otherwise.
- **Switch to Claude’s tabs** setting. When off, Claude opens its tabs in a separate background window and never brings your tabs to the front.
- `eval` on sites with a strict Content Security Policy uses user scripts when the browser allows them, instead of the debugger.
- Usage limits are read from claude.ai when the panel opens, with a refresh button.
- Bulleted and numbered lists in replies render as real lists.
- Screenshot of the chat window in the README.

## 0.1.0

First public release.

- Chat in the toolbar popup, with pasted screenshots and live progress.
- Per-tab access with a checkbox for every tab.
- Two modes: send requests to an open Claude Code session, or let the host run Claude Code with a chosen model and effort.
- Page reading (map, text, HTML, console, network) and actions (click, type, keys, scroll, real input).
- Video and audio: frame sheets, frame-by-frame ranges, speech recognition, tempo and beats, editing.
- Usage limits read from claude.ai.
- Automatic rejection of cookie banners; CAPTCHA detection.
- Interface in English, Ukrainian, Russian, Spanish and German; light and dark themes.

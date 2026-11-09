# Changelog

## 0.7.0

- Claude Code chats are no longer mixed into the model picker. The picker lists **Claude Code chat** and the models; the chosen chat shows as a label above the input (click it to choose another, it turns amber when that chat is offline).
- Cleaner composer: the placeholder is just "What should I do?", the model, effort and language lists are as wide as their value, and the input, picker and chips share one left edge.
- Menus and panels line up with the window edge; every menu row has an icon column. In the chats list dates and the delete button no longer shift rows. "New chat" lives in the chats list only.

## 0.6.0

- **Reload extension** in the menu ⋯: restarts the local host and reloads the extension in one click, applying changed files and clearing a stuck state. Connected Claude Code chats reconnect by themselves. Also available as `bh.js reload-all`.
- The chats list now has two sections: **Claude Code chats** (connected right now; click one to send your next messages there) and **Conversations**.

## 0.5.0

- **Chats list.** "New chat" no longer deletes anything: it starts a new conversation and keeps the old ones. The list icon at the top shows every conversation to switch to or delete. Each conversation keeps its own memory when a model handles it, and answers land in the conversation the question came from.
- **Security.** When the host runs Claude Code with a chosen model, it can now only run the BrowserHand CLI and read BrowserHand's own files (screenshots, pasted images, media). Direct `ffmpeg` and `yt-dlp` are gone: `yt-dlp --exec` could run any command a malicious page talked the model into. Video and audio still work through `media`.
- A notice appears when a Claude Code chat connects; the connect text asks the chat to name itself, and `bh.js sessions` lists connected chats.
- Answers from a chat connected under `name=...` are labelled with that name even when it replies without it.

## 0.4.0

- Several Claude Code chats at once, from different projects. Each connected chat appears in the picker as **Chat: <folder>**; a message goes only to the chat you picked, and the answer shows which chat sent it. Messages for a chat that isn't connected wait for it.
- Connecting is one sentence: `setup.js` installs a Claude Code skill with this computer's paths, so in any chat you can say "connect to BrowserHand" or type /browserhand. **Connect a Claude Code chat…** in the menu shows a ready-to-paste text with the real install path as well.
- `watch` explains to the chat what to do with the messages it prints; `watch name=<label>` sets the name.

## 0.3.2

- After an update the extension reloads only once the old host has closed the connection, and the host restarts without waiting for open connections. Before, the reloaded extension could stay attached to the old host while a new one started without it.
- The connection heals itself: the extension pings the host every 10 seconds and reconnects when there is no answer, and the host adopts whichever connection talks to it.

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

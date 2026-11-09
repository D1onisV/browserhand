<p align="center">
  <img src="extension/icons/128.png" width="88" alt="BrowserHand">
</p>

<h1 align="center">BrowserHand</h1>

<p align="center">
  Let Claude Code see and drive the browser you already use.<br>
  Tabs, pages, clicks, screenshots, video and audio, from a chat in your toolbar or straight from Claude Code.
</p>

<p align="center">
  <a href="LICENSE">MIT</a> ·
  Chrome · Brave · Edge · Opera · Vivaldi ·
  English · Українська · Русский · Español · Deutsch
</p>

<p align="center">
  <img src="docs/screenshot.png" width="820" alt="BrowserHand chat window in light and dark themes">
</p>

## What is BrowserHand?

BrowserHand is a browser extension plus a small local host that gives [Claude Code](https://docs.claude.com/en/docs/claude-code/overview) hands in your real browser. You type a request in the extension's chat, for example "compare the prices in these three tabs" or "what happens in this video at 2:10", and Claude does it with your tabs, your sign-ins and your settings.

Unlike automation tools that launch a separate, empty browser, BrowserHand works inside the browser you are already signed in to. You decide which tabs it can touch.

| | Separate automation browser (Playwright, Puppeteer) | BrowserHand |
|---|---|---|
| Sign-ins | Log in again in a fresh profile | Uses the sessions you already have |
| Setup | Downloads its own browser | Loads into your browser as an extension |
| Your tabs | Can't see them | Sees the tabs you allow, one checkbox each |
| Talking to it | Code or an MCP client | A chat in the toolbar, or any Claude Code session |
| Video and audio | Not included | Frames, speech-to-text, beats, editing |

## Features

- **Chat in the toolbar.** Ask in plain language, paste screenshots with Ctrl+V, and see what Claude is doing step by step.
- **Many conversations.** Start a new chat without losing the old one; switch between them from the list at the top.
- **Per-tab access.** A checkbox for every tab. Hidden tabs don't exist for Claude: it can't list, read, click or screenshot them.
- **Two ways to run.** Send requests to your open Claude Code session, or let the host run Claude Code on its own with the model and effort you pick (Opus, Sonnet, Haiku, Fable).
- **Reads pages the way an agent needs.** A compact map of headings and controls with stable ids, text, cleaned HTML, console logs and network requests.
- **Acts like a person.** Clicks, typing, keys, scrolling and hovering as page events, so the browser shows no debugging bar. Turn on **Real click and keyboard** for the rare site that only trusts real input.
- **Stays out of your way.** Turn off **Switch to Claude’s tabs** and Claude works in its own background window while you keep using yours.
- **Watches video, listens to audio.** Contact sheets of frames with timestamps, frame-by-frame for a chosen moment, local speech recognition with subtitles, tempo and beat detection, plus trimming, joining, 9:16, GIFs and burned-in subtitles.
- **Usage limits at a glance.** Your current session and weekly limits, read from claude.ai with your existing sign-in.
- **Rejects cookie banners.** Clicks "Reject" or "Only necessary". Never "Accept".
- **Stops at CAPTCHAs.** It detects them and asks you to solve them yourself.
- **Local only.** The host listens on 127.0.0.1 and accepts only this extension. Nothing is sent anywhere except to Claude itself.

## Requirements

- Node.js 18 or newer
- A Chromium-based browser: Chrome, Brave, Edge, Opera or Vivaldi
- [Claude Code](https://docs.claude.com/en/docs/claude-code/overview), signed in
- Optional, for video and audio: Python 3.9+, `ffmpeg` and `yt-dlp`

## Quick start

1. **Get the latest version**

   Download **[browserhand.zip](https://github.com/D1onisV/browserhand/releases/latest/download/browserhand.zip)** (always the newest release) and unzip it, or clone the repository:

   ```bash
   git clone https://github.com/D1onisV/browserhand.git
   cd browserhand
   ```

2. **Install the host** (and start it at login)

   ```bash
   node setup.js --autostart
   ```

   Add `--media` to install the video and audio tools too, or `--no-skill` to skip the Claude Code skill (`node host/skill.js` installs it later, `--remove` removes it).

3. **Load the extension**

   1. Open `chrome://extensions` (or `brave://`, `edge://`, `opera://`, `vivaldi://extensions`).
   2. Turn on **Developer mode**.
   3. Click **Load unpacked** and choose the `extension` folder.

4. **Open the chat.** Click the BrowserHand icon or press <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>B</kbd>. A green dot means everything is connected.

## Updating

BrowserHand checks for a new release once a day. When there is one, the menu ⋯ shows **Update to vX.Y.Z** and the toolbar icon shows **NEW**. One click downloads the release, replaces the files, keeps your chats, settings and media tools, and reloads the extension.

From a terminal:

```bash
node host/bh.js update          # update now
node host/bh.js update --check  # only compare versions
```

A git checkout is updated with `git pull`. If the host is not running, `node host/update.js` does the same on its own. Every version is listed on the [releases page](https://github.com/D1onisV/browserhand/releases) with its notes.

## Settings

The menu ⋯ in the chat window:

| Setting | Default | What it does |
|---|---|---|
| Browser access | on | Off disconnects the extension from the host at once. |
| New tabs get access | on | Whether tabs you open later are visible to Claude. Tabs Claude opens are always visible to it. |
| Reject cookie banners | on | Clicks “Reject” or “Only necessary”, never “Accept”. |
| Switch to Claude’s tabs | on | Off: Claude’s tabs open in a separate unfocused window, and your tabs are never brought to the front. Screenshots of your background tabs are skipped then. |
| Real click and keyboard | off | Trusted input, full-page screenshots and `eval` on strict sites through the browser’s debugger. While it is in use, the browser shows a “debugging this browser” bar. |
| Language | English | English, Українська, Русский, Español, Deutsch. |

The sun/moon icon switches the light and dark themes.

## Two ways to run requests

Pick one in the list under the message box.

**A model (Opus, Sonnet, Haiku, Fable).** The host starts Claude Code in the background with that model and effort, gives it only the browser commands and the image reader, and keeps one conversation going until you click **New chat**. Nothing else needs to be open.

**A Claude Code chat.** Requests go to a Claude Code chat you have open, in any project. You can connect several chats at once: pick **Claude Code chat** in the picker, then choose the chat in the chats list (or click the chat label above the input). A message goes only to that chat.

To connect a chat, say in it **"connect to BrowserHand"** or type **/browserhand**. `setup.js` installs a Claude Code skill with the right paths for your computer, so the chat knows what to run. Without the skill, open **Connect a Claude Code chat…** in the menu ⋯ and paste the text it shows; it already contains your install path.

Under the hood the chat runs, in the background:

```bash
node host/bh.js watch                # appears as the folder name
node host/bh.js watch name=shop      # or under a name you choose
```

Each message arrives with the current tab and any pasted images; the chat answers with `node host/bh.js reply "..."`, and the answer is labelled with the chat's name. A message for a chat that isn't connected waits until it connects.

## Examples

> What's on this page, and which buttons sign me in?

> Compare the three laptops in my open tabs: price, weight, battery. Short table.

> Watch this video and tell me what it's about, with timestamps of the key moments.

> Show me 0:42–0:45 frame by frame. Does the logo flicker?

> Find the tempo of this track and cut the video to the first 8 beats.

> Turn on dark mode on this site and take a screenshot.

## Commands

Everything the extension can do is also a command, so any Claude Code session (or you) can call it:

```bash
node host/bh.js <command> [args]
```

| Area | Commands |
|---|---|
| Tabs | `tabs` · `open <url>` · `nav <url>` · `back` · `forward` · `reload` · `activate` · `close` |
| Reading | `map` · `find "text"` · `text [selector]` · `html [selector]` · `info` |
| Acting | `click <id\|css\|text=…>` · `type <target> "text"` · `key "ctrl+a Enter"` · `select` · `hover` · `focus` · `scroll` · `wait` |
| Debugging | `eval "js"` · `console [errors=true]` · `net [errors=true]` · `shot [full=true]` |
| Video on the page | `video [info\|play\|pause\|seek t=1:23\|rate rate=1.5\|frame]` |
| Several at once | `batch '[{"cmd":"map"},{"cmd":"click","target":12}]'` |
| Video and audio files | `media info\|look\|frame\|hear\|sound\|get\|cut\|audio\|concat\|vertical\|subs\|gif\|speed <url-or-file>` |

`node host/bh.js help` lists every command the connected extension supports.

## Configuration

Create `host/config.json` to change the defaults:

| Key | Default | Meaning |
|---|---|---|
| `port` | `17321` | Port of the local host. Set the same value as `hostPort` in the extension's storage. |
| `extensionIds` | the ID pinned by the manifest key | Extensions allowed to connect. Add your ID if you publish your own build. |
| `claudeBin` | found automatically | Path to the `claude` executable. |
| `updateRepo` | `D1onisV/browserhand` | Where updates come from (`owner/name` on GitHub). |

Environment variables `BH_PORT` and `CLAUDE_BIN` override the file.

## Security and privacy

- The host listens on `127.0.0.1` only, checks the `Host` header, rejects browser origins on its HTTP API and requires a random token stored in `host/data/.token`.
- The WebSocket accepts only the extension IDs listed in the configuration.
- A Claude Code run started by the host may only use the BrowserHand CLI and read BrowserHand's own files in `host/data/`; it cannot run other programs or read the rest of your disk.
- Web pages can still try to talk the model into actions (prompt injection). Keep tabs with sensitive accounts unticked when you don't need them.
- Each tab is opt-in or opt-out with a checkbox, and **Browser access** in the menu cuts the connection at once.
- Claude never types passwords or payment details and never solves CAPTCHAs. Text on web pages is treated as data, not as instructions.
- Chats, screenshots, pasted images and media files stay in `host/data/` on your machine.
- Usage limits are read from claude.ai with the session your browser already has. Nothing else is read from your account.

## Troubleshooting

| Problem | Fix |
|---|---|
| "The local host is not running" | Run `host/start-host.vbs` (Windows) or `host/start-host.sh`. Logs are in `host/data/host.log`. |
| "Claude exited without an answer" | Install Claude Code and sign in once with `claude`. |
| Claude can't see a tab | Tick it in the **Tabs** list. Browser pages like `chrome://` can't be accessed by any extension. |
| Console log is empty | Reload pages that were open before the extension was installed. |
| Speech recognition is slow | It runs on the CPU. With an NVIDIA GPU, install `nvidia-cublas-cu12` and `nvidia-cudnn-cu12` into `host/.venv-media`. |
| Moved the folder | Run `node setup.js --autostart` again to rewrite the launcher paths. |

## Project layout

```
extension/        the browser extension (Manifest V3)
  background.js   commands, per-tab access, connection to the host, chat relay
  modules/        browser control commands
  content/        scripts that run in pages: page helper, console hook, cookie banners
  ui/             the chat window and its translations
  _locales/       extension name and description in each language
host/
  server.js       local host: WebSocket for the extension, HTTP for the CLI, background Claude runs
  bh.js           command-line client
  media.py        video and audio tool
setup.js          installer
```

## Contributing

Issues and pull requests are welcome. Run `npm run check` before sending a change: it checks the syntax of every script and that all translations have the same keys.

## License

[MIT](LICENSE)

BrowserHand is an independent project and is not affiliated with or endorsed by Anthropic. Claude and Claude Code are trademarks of Anthropic.

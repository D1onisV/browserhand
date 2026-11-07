#!/usr/bin/env node
// BrowserHand setup:  node setup.js [--autostart] [--media]
//
// Installs the host's dependency, writes a launcher for this OS and this folder, optionally
// registers it to run at login (--autostart) and installs the video/audio tools (--media),
// then starts the host and prints how to load the extension.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');

const ROOT = __dirname;
const HOST = path.join(ROOT, 'host');
const NODE = process.execPath;
const WINDOWS = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const flag = (name) => process.argv.includes(name);
const step = (text) => console.log('\n> ' + text);
const info = (text) => console.log('  ' + text);

function commandExists(cmd) {
  for (const arg of ['-version', '--version']) {
    try { execSync(`${cmd} ${arg}`, { stdio: 'ignore' }); return true; } catch { /* try the next form */ }
  }
  return false;
}

function installHost() {
  step('Installing the host dependency');
  execSync('npm install --omit=dev --silent', { cwd: HOST, stdio: 'inherit' });
  info('done');
}

function installMedia() {
  step('Media tools: checking ffmpeg and yt-dlp');
  const hints = {
    ffmpeg: WINDOWS ? 'winget install Gyan.FFmpeg' : MAC ? 'brew install ffmpeg' : 'sudo apt install ffmpeg',
    'yt-dlp': WINDOWS ? 'winget install yt-dlp.yt-dlp' : MAC ? 'brew install yt-dlp' : 'pipx install yt-dlp',
  };
  for (const [cmd, hint] of Object.entries(hints)) info(commandExists(cmd) ? `${cmd}: found` : `${cmd}: missing, install it with  ${hint}`);

  step('Media tools: installing speech recognition and audio analysis (separate Python environment)');
  const venv = path.join(HOST, '.venv-media');
  const python = WINDOWS ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
  try {
    if (!fs.existsSync(python)) execSync(`${WINDOWS ? 'python' : 'python3'} -m venv "${venv}"`, { stdio: 'inherit' });
    execSync(`"${python}" -m pip install --quiet --upgrade pip`, { stdio: 'inherit' });
    execSync(`"${python}" -m pip install --quiet faster-whisper librosa soundfile`, { stdio: 'inherit' });
    info('done. The speech model (~1.6 GB) downloads on first use.');
  } catch {
    info('failed. Python 3.9 or newer is required; then run  node setup.js --media  again.');
  }
}

function writeLauncher() {
  step('Writing the launcher');
  const log = path.join(HOST, 'data', 'host.log');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  let launcher;
  if (WINDOWS) {
    launcher = path.join(HOST, 'start-host.vbs');
    const vbs = [
      "' Starts the BrowserHand host without a console window. A second copy exits on its own.",
      'Set sh = CreateObject("WScript.Shell")',
      `sh.CurrentDirectory = "${HOST}"`,
      `sh.Run "cmd /c """"${NODE}"" ""${path.join(HOST, 'server.js')}"" >> ""${log}"" 2>&1""", 0, False`,
      '',
    ].join('\r\n');
    // VBScript reads non-ASCII paths correctly only from UTF-16 files.
    fs.writeFileSync(launcher, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(vbs, 'utf16le')]));
  } else {
    launcher = path.join(HOST, 'start-host.sh');
    fs.writeFileSync(launcher, `#!/bin/sh\n# Starts the BrowserHand host in the background.\ncd "${HOST}"\nexec "${NODE}" server.js >> "${log}" 2>&1\n`);
    fs.chmodSync(launcher, 0o755);
  }
  info(launcher);
  return launcher;
}

function registerAutostart(launcher) {
  step('Registering the host to start at login');
  if (WINDOWS) {
    const target = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup', 'BrowserHand.vbs');
    fs.copyFileSync(launcher, target);
    info(target);
  } else if (MAC) {
    const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    fs.mkdirSync(dir, { recursive: true });
    const plist = path.join(dir, 'dev.browserhand.host.plist');
    fs.writeFileSync(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>dev.browserhand.host</string>
  <key>ProgramArguments</key><array><string>${launcher}</string></array>
  <key>RunAtLoad</key><true/>
</dict></plist>\n`);
    info(`${plist} (takes effect at the next login)`);
  } else {
    const dir = path.join(os.homedir(), '.config', 'autostart');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'browserhand.desktop');
    fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=BrowserHand\nExec=${launcher}\nX-GNOME-Autostart-enabled=true\n`);
    info(file);
  }
}

function startHost(launcher) {
  step('Starting the host');
  const child = WINDOWS
    ? spawn('wscript.exe', [launcher], { detached: true, stdio: 'ignore', windowsHide: true })
    : spawn('/bin/sh', [launcher], { detached: true, stdio: 'ignore' });
  child.unref();
  info('listening on 127.0.0.1:17321');
}

function main() {
  if (+process.versions.node.split('.')[0] < 18) {
    console.log('Node.js 18 or newer is required: https://nodejs.org');
    process.exit(1);
  }
  installHost();
  if (flag('--media')) installMedia();
  const launcher = writeLauncher();
  if (flag('--autostart')) registerAutostart(launcher);
  startHost(launcher);

  console.log(`
Now load the extension:

  1. Open the extensions page: chrome://extensions, brave://extensions, edge://extensions,
     opera://extensions or vivaldi://extensions
  2. Turn on Developer mode.
  3. Click "Load unpacked" and choose:
       ${path.join(ROOT, 'extension')}
  4. Click the BrowserHand icon in the toolbar.

To let BrowserHand run requests with a chosen model (without an open Claude Code session),
install Claude Code and sign in once:  npm install -g @anthropic-ai/claude-code  then  claude
`);
}

try {
  main();
} catch (e) {
  console.error('\nSetup failed: ' + e.message);
  process.exit(1);
}

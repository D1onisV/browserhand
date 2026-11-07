// Updates this BrowserHand folder to the latest GitHub release.
//
//   node host/update.js            update if a newer release exists
//   node host/update.js --check    only report the installed and latest versions
//
// A git checkout is updated with `git pull --ff-only`. A downloaded copy gets the release zip;
// user data is kept: host/data, host/config.json, host/.venv-media, host/node_modules.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const HOST_DIR = __dirname;
const ROOT = path.resolve(HOST_DIR, '..');
const config = (() => { try { return JSON.parse(fs.readFileSync(path.join(HOST_DIR, 'config.json'), 'utf8')); } catch { return {}; } })();
const REPO = config.updateRepo || 'D1onisV/browserhand';
const ASSET = 'browserhand.zip';
const KEEP = ['.git', 'host/data', 'host/config.json', 'host/.venv-media', 'host/node_modules'];

const installedVersion = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'extension', 'manifest.json'), 'utf8')).version;

function newer(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

function get(url, { json = false, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'BrowserHand-updater', accept: json ? 'application/vnd.github+json' : '*/*' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirects > 0) {
        res.resume();
        return resolve(get(res.headers.location, { json, redirects: redirects - 1 }));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`GitHub answered ${res.statusCode} for ${url}`)); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        try { resolve(json ? JSON.parse(body.toString('utf8')) : body); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function latestRelease() {
  const release = await get(`https://api.github.com/repos/${REPO}/releases/latest`, { json: true });
  const asset = (release.assets || []).find((a) => a.name === ASSET);
  return {
    version: String(release.tag_name || '').replace(/^v/, ''),
    url: asset ? asset.browser_download_url : null,
    page: release.html_url,
    notes: release.body || '',
  };
}

async function check() {
  const installed = installedVersion();
  const latest = await latestRelease();
  return { installed, latest: latest.version, available: newer(latest.version, installed), page: latest.page, notes: latest.notes, release: latest };
}

function copyOver(from, to, rel = '') {
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (KEEP.includes(relPath)) continue;
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dst, { recursive: true });
      copyOver(src, dst, relPath);
    } else {
      fs.copyFileSync(src, dst);
    }
  }
}

function unzip(zipFile, dir) {
  fs.mkdirSync(dir, { recursive: true });
  if (process.platform === 'win32') {
    // Use Windows' own bsdtar: a GNU tar from Git or MSYS earlier in PATH can't read "C:\..." paths.
    const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(tar)) return execFileSync(tar, ['-xf', zipFile, '-C', dir]);
    return execFileSync('powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${dir}' -Force`]);
  }
  if (process.platform === 'darwin') return execFileSync('tar', ['-xf', zipFile, '-C', dir]); // bsdtar reads zip
  return execFileSync('unzip', ['-q', '-o', zipFile, '-d', dir]);
}

async function update({ log = console.log } = {}) {
  const status = await check();
  if (!status.available) return { updated: false, ...status };

  if (fs.existsSync(path.join(ROOT, '.git'))) {
    log('git checkout: pulling the latest version');
    execFileSync('git', ['pull', '--ff-only'], { cwd: ROOT, stdio: 'inherit' });
  } else {
    if (!status.release.url) throw new Error(`release ${status.latest} has no ${ASSET}`);
    const work = path.join(HOST_DIR, 'data', 'update');
    fs.rmSync(work, { recursive: true, force: true });
    fs.mkdirSync(work, { recursive: true });
    log(`downloading ${status.latest}`);
    const zipFile = path.join(work, ASSET);
    fs.writeFileSync(zipFile, await get(status.release.url));
    log('unpacking');
    unzip(zipFile, path.join(work, 'files'));
    const top = path.join(work, 'files', 'browserhand');
    const source = fs.existsSync(path.join(top, 'extension', 'manifest.json')) ? top : path.join(work, 'files');
    if (!fs.existsSync(path.join(source, 'extension', 'manifest.json'))) throw new Error('the downloaded archive does not look like BrowserHand');
    log('replacing files (your chats and settings stay)');
    copyOver(source, ROOT);
    fs.rmSync(work, { recursive: true, force: true });
  }

  log('installing dependencies');
  execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install', '--omit=dev', '--silent'], { cwd: HOST_DIR, stdio: 'inherit', shell: process.platform === 'win32' });
  return { updated: true, ...status, installed: installedVersion() };
}

module.exports = { check, update, newer };

if (require.main === module) {
  const run = process.argv.includes('--check') ? check : update;
  run().then((r) => {
    if (process.argv.includes('--check')) console.log(`installed ${r.installed}, latest ${r.latest}${r.available ? ' — update available' : ' — up to date'}`);
    else console.log(r.updated ? `updated to ${r.installed}. Reload the extension (or click Update in its menu next time).` : `already up to date (${r.installed})`);
  }).catch((e) => { console.error('ERROR: ' + e.message); process.exitCode = 1; });
}

// Syntax check for every JavaScript file and a key-parity check for the UI translations.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const skip = new Set(['node_modules', 'data', '.venv-media', '.git']);
const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else if (entry.name.endsWith('.js')) files.push(full);
  }
})(root);

let failed = 0;
for (const file of files) {
  try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
  catch (e) { failed++; console.error(String(e.stderr)); }
}

const src = fs.readFileSync(path.join(root, 'extension/ui/i18n.js'), 'utf8');
const STRINGS = new Function(`${src}; return STRINGS;`)();
const base = Object.keys(STRINGS.en);
for (const [lang, table] of Object.entries(STRINGS)) {
  const keys = Object.keys(table);
  const missing = base.filter((k) => !keys.includes(k));
  const extra = keys.filter((k) => !base.includes(k));
  if (missing.length || extra.length) {
    failed++;
    console.error(`${lang}: missing ${missing.join(', ') || '-'}; extra ${extra.join(', ') || '-'}`);
  }
}

console.log(failed ? `${failed} problem(s)` : `ok: ${files.length} files, ${Object.keys(STRINGS).length} languages`);
process.exitCode = failed ? 1 : 0;

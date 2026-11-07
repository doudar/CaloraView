'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const binaries = new Set(['assets/brand/icon.png', 'assets/brand/icon.ico', 'assets/brand/icon.icns', 'assets/brand/skarix-icon.png', 'src/renderer/assets/icon.png', 'src/models/fsrcnn-x2.onnx', 'src/models/real-general-dn50-gray2x.onnx']);
function validatePath(name) {
  const parts = name.split('/');
  if (parts.some(p => !p || p === '.' || p === '..') || path.isAbsolute(name)) throw new Error('Invalid repository path: ' + name);
  if (parts.some(p => ['node_modules', 'build', 'dist', '.tools', 'captures', 'test-output', '__pycache__', 'decompiled'].includes(p.toLowerCase())) || parts[0].toLowerCase() === 'research') throw new Error('Generated/private directory in repository: ' + name);
  if (!binaries.has(name) && !/\.(?:cjs|js|json|md|txt|html|css|cs|ps1|py|java|xml|ya?ml)$/.test(name) && !['LICENSE', '.gitignore', '.gitattributes', '.editorconfig'].includes(parts.at(-1))) throw new Error('Unapproved file type in repository: ' + name);
}
function checkRepository() {
  const files = [...new Set(execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean))];
  for (const name of files) {
    validatePath(name);
    const stat = fs.lstatSync(name);
    if (!stat.isFile()) throw new Error('Only regular files may be published: ' + name);
    if (stat.size > 10 * 1024 * 1024) throw new Error('Unexpected large file: ' + name);
    if (!binaries.has(name)) {
      const data = fs.readFileSync(name, 'utf8');
      if (data.includes('\0') || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}/.test(data)) throw new Error('Binary content or credential in text file: ' + name);
    }
  }
  const manifest = JSON.parse(fs.readFileSync('src/models/manifest.json', 'utf8'));
  for (const model of manifest.models) {
    const name = 'src/models/' + model.file;
    if (!binaries.has(name)) throw new Error('Unapproved model: ' + name);
    const bytes = fs.readFileSync(name);
    if (bytes.length !== model.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== model.sha256) throw new Error('Model integrity mismatch: ' + name);
  }
  console.log(`Repository guard passed: ${files.length} source, documentation and approved runtime asset files.`);
}
if (require.main === module) checkRepository();
module.exports = { validatePath };

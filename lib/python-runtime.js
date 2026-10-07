'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os');

// 受信任校验器使用的 Python：JOBHUNT_PYTHON → 作者本机 Codex 运行时（存在时）→ PATH 上的 python。
const CODEX_PYTHON = path.join(
  os.homedir(),
  '.cache/codex-runtimes/codex-primary-runtime/dependencies/python/python.exe'
);
function defaultPython(env = process.env) {
  if (env.JOBHUNT_PYTHON) return env.JOBHUNT_PYTHON;
  if (fs.existsSync(CODEX_PYTHON)) return CODEX_PYTHON;
  return process.platform === 'win32' ? 'python' : 'python3';
}

module.exports = { defaultPython, CODEX_PYTHON };

const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {defaultPython,CODEX_PYTHON}=require('../lib/python-runtime');

test('JOBHUNT_PYTHON wins over every fallback',()=>{
 assert.equal(defaultPython({JOBHUNT_PYTHON:'/opt/py/bin/python'}),'/opt/py/bin/python');
});
test('without override, use the Codex runtime only when it exists, else python on PATH',()=>{
 const expected=fs.existsSync(CODEX_PYTHON)?CODEX_PYTHON:(process.platform==='win32'?'python':'python3');
 assert.equal(defaultPython({}),expected);
});

/* 静态检查：app.js 里调用的函数是否都有定义（防止引用未实现的函数） */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const raw = fs.readFileSync(path.join(HERE, 'app.js'), 'utf8');

/* 把字符串、模板串、注释、正则字面量替换成占位，避免误报 */
function countNL(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') n++;
  return n;
}

function scrub(code) {
  let out = '';
  let i = 0;
  let prevSignificant = '';
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];

    if (c === '/' && n === '/') {
      const start = i;
      while (i < code.length && code[i] !== '\n') i++;
      out += '\n'.repeat(countNL(code.slice(start, i)));
      continue;
    }
    if (c === '/' && n === '*') {
      const start = i;
      i += 2;
      while (i < code.length && !(code[i] === '*' && code[i + 1] === '/')) i++;
      i += 2;
      out += '\n'.repeat(countNL(code.slice(start, i)));
      continue;
    }
    if (c === "'" || c === '"') {
      const q = c;
      const start = i;
      i++;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === q) { i++; break; }
        i++;
      }
      out += ' S ' + '\n'.repeat(countNL(code.slice(start, i)));
      prevSignificant = 'S';
      continue;
    }
    if (c === '`') {
      const start = i;
      i++;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === '`') { i++; break; }
        i++;
      }
      out += ' S ' + '\n'.repeat(countNL(code.slice(start, i)));
      prevSignificant = 'S';
      continue;
    }
    // 正则字面量：/ 出现在运算符或开头之后
    if (c === '/' && /[=(,:;[!&|?{};+\-*%<>~^]/.test(prevSignificant || '=')) {
      const start = i;
      i++;
      let inClass = false;
      while (i < code.length) {
        if (code[i] === '\\') { i += 2; continue; }
        if (code[i] === '[') inClass = true;
        else if (code[i] === ']') inClass = false;
        else if (code[i] === '/' && !inClass) { i++; break; }
        else if (code[i] === '\n') break;
        i++;
      }
      while (i < code.length && /[a-z]/i.test(code[i])) i++;
      out += ' R ' + '\n'.repeat(countNL(code.slice(start, i)));
      prevSignificant = 'R';
      continue;
    }
    out += c;
    if (!/\s/.test(c)) prevSignificant = c;
    i++;
  }
  return out;
}

const calls_src = scrub(raw);
const src = raw;

const GLOBALS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'function',
  'else', 'do', 'try', 'in', 'of', 'delete', 'void', 'await', 'async', 'yield',
  'super', 'this', 'case', 'throw', 'instanceof', 'var', 'let', 'const',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Math', 'JSON', 'Date',
  'Promise', 'RegExp', 'Error', 'Map', 'Set', 'Symbol', 'Intl',
  'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'encodeURIComponent',
  'decodeURIComponent', 'encodeURI', 'decodeURI', 'structuredClone',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
  'requestAnimationFrame', 'cancelAnimationFrame', 'queueMicrotask',
  'fetch', 'Response', 'Request', 'Headers', 'AbortController', 'Blob', 'File',
  'FileReader', 'FormData', 'URL', 'URLSearchParams', 'TextDecoder', 'TextEncoder',
  'ReadableStream', 'WritableStream', 'TransformStream', 'Audio', 'Image',
  'SpeechSynthesisUtterance', 'MutationObserver', 'IntersectionObserver',
  'ResizeObserver', 'localStorage', 'sessionStorage', 'navigator', 'document',
  'window', 'speechSynthesis', 'console', 'alert', 'confirm', 'prompt',
  'getComputedStyle', 'matchMedia', 'crypto', 'atob', 'btoa', 'Uint8Array',
  'Float64Array', 'Int32Array', 'ArrayBuffer', 'DataView'
]);

const defined = new Set();
for (const m of src.matchAll(/function\s+([A-Za-z_$][\w$]*)\s*\(/g)) defined.add(m[1]);
for (const m of src.matchAll(/var\s+([A-Za-z_$][\w$]*)\s*=/g)) defined.add(m[1]);
for (const m of src.matchAll(/function\s*[\w$]*\s*\(([^)]*)\)/g)) {
  m[1].split(',').forEach((p) => {
    const name = p.trim().split('=')[0].trim();
    if (/^[A-Za-z_$][\w$]*$/.test(name)) defined.add(name);
  });
}

const problems = new Map();
for (const m of calls_src.matchAll(/(^|[^.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
  const name = m[2];
  if (GLOBALS.has(name) || defined.has(name)) continue;
  if (problems.has(name)) continue;
  const line = calls_src.slice(0, m.index + m[1].length).split('\n').length;
  problems.set(name, line);
}

// 常量检查：引用了大写常量但从未声明
const consts = new Set();
for (const m of src.matchAll(/(?:var|let|const)\s+([A-Z][A-Z0-9_]{2,})\b/g)) consts.add(m[1]);
const constProblems = new Map();
for (const m of calls_src.matchAll(/(^|[^.\w$])([A-Z][A-Z0-9_]{2,})\b(?!\s*:)/g)) {
  const name = m[2];
  if (consts.has(name) || GLOBALS.has(name)) continue;
  if (constProblems.has(name)) continue;
  const line = calls_src.slice(0, m.index + m[1].length).split('\n').length;
  constProblems.set(name, line);
}
if (constProblems.size) {
  console.error('\x1b[31m✗ 引用了未声明的大写常量：\x1b[0m');
  for (const [name, line] of constProblems) console.error(`   ${name}  ← app.js:${line}`);
  process.exit(1);
}

if (problems.size) {
  console.error('\x1b[31m✗ 发现调用了未定义的函数：\x1b[0m');
  for (const [name, line] of problems) console.error(`   ${name}()  ← app.js:${line}`);
  process.exit(1);
}
console.log('静态检查通过：所有函数调用都有定义');

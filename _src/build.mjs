/* 构建：把 CSS / JS 内联进单文件 index.html */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// 构建前先做静态检查：引用未定义函数就直接中止
try {
  execFileSync(process.execPath, [path.join(HERE, 'lint.mjs')], { stdio: 'inherit' });
} catch (e) {
  console.error('\x1b[31m构建中止：静态检查未通过\x1b[0m');
  process.exit(1);
}

const tpl = fs.readFileSync(path.join(HERE, 'index.template.html'), 'utf8');
const css = fs.readFileSync(path.join(HERE, 'app.css'), 'utf8');
const js = fs.readFileSync(path.join(HERE, 'app.js'), 'utf8');

if (/<\/script>/i.test(js)) throw new Error('app.js 含有 </script>，无法内联');

const out = tpl.replace('{{CSS}}', () => css.trim()).replace('{{JS}}', () => js.trim());

if (out.includes('{{')) throw new Error('还有未替换的占位符');

const file = path.join(ROOT, 'index.html');
fs.writeFileSync(file, out);
console.log(`index.html  ${(Buffer.byteLength(out) / 1024).toFixed(1)} KB`);

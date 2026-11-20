/* 生成用于视觉验收的 HTML 变体（注入假数据） */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, '_build', 'shots');
fs.mkdirSync(OUT, { recursive: true });

const base = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

const now = Date.now();
const seed = {
  settings: {
    apiKey: 'sk-fake-only-for-screenshots',
    model: 'deepseek-chat',
    system: '',
    temperature: 1.0,
    keepTurns: 20,
    theme: 'dark'
  },
  currentId: 'c1',
  convs: [
    {
      id: 'c1',
      title: '嵌套数组求和',
      createdAt: now - 3600e3,
      updatedAt: now - 60e3,
      messages: [
        {
          role: 'user',
          content: '接口返回里 items 是嵌套数组，我想把所有 price 加起来，怎么写更稳妥？',
          ts: now - 300e3
        },
        {
          role: 'assistant',
          ts: now - 290e3,
          content: [
            '可以分两步：先把嵌套结构拍平，再累加。',
            '',
            '```js',
            'function sumPrice(node) {',
            '  if (Array.isArray(node)) return node.reduce((s, n) => s + sumPrice(n), 0);',
            '  if (!node) return 0;',
            '  const p = Number(node.price);',
            '  return Number.isFinite(p) ? p : 0;',
            '}',
            '',
            'console.log(sumPrice(resp.data));',
            '```',
            '',
            '要点：',
            '',
            '- `Number("19.90")` 直接得到 `19.9`，不用手动 `parseFloat`',
            '- 遇到 `null` / `undefined` 先短路返回 `0`，避免 `NaN` 污染累加结果',
            '- 数据量超过 10 万条时递归可能爆栈，建议改成显式栈',
            '',
            '> 如果金额涉及小数，记得最后统一 `toFixed(2)`，不要在每个中间步骤取整。'
          ].join('\n')
        },
        { role: 'user', content: '那如果 price 是字符串，或者字段干脆不存在呢？', ts: now - 100e3 },
        {
          role: 'assistant',
          ts: now - 90e3,
          content: [
            '两种情况都能被 `Number.isFinite` 兜住：',
            '',
            '| 输入 | `Number(x)` | 结果 |',
            '| --- | --- | --- |',
            '| `"19.90"` | `19.9` | 计入 |',
            '| `undefined` | `NaN` | 跳过 |',
            '| `"abc"` | `NaN` | 跳过 |',
            '',
            '所以只要守住 **“不是有限数字就当 0”** 这一条规则，就不必为每种脏数据单独写分支。',
            '',
            '需要我把它整理成一个可复用的 `sumBy` 工具函数吗？'
          ].join('\n')
        }
      ]
    },
    {
      id: 'c2',
      title: '把这段周报改得更书面',
      createdAt: now - 86400e3,
      updatedAt: now - 7200e3,
      messages: [{ role: 'user', content: '把这段周报改得更书面一点', ts: now - 7200e3 }]
    },
    {
      id: 'c3',
      title: '杭州两日游计划',
      createdAt: now - 3 * 86400e3,
      updatedAt: now - 2 * 86400e3,
      messages: [{ role: 'user', content: '杭州两日游怎么安排', ts: now - 2 * 86400e3 }]
    }
  ]
};

// 给最后一条回答补上「思考过程」，用于验证 R1 折叠块样式
seed.convs[0].messages[3].reasoning =
  '用户问的是 price 为字符串或字段缺失时怎么处理。\n' +
  '关键点：Number("19.90") 得到 19.9，Number(undefined) 得到 NaN，\n' +
  'Number("abc") 也是 NaN。用 Number.isFinite 一次性过滤掉后两者即可，\n' +
  '不需要为每种脏数据写分支。最后提醒一下小数取整的时机。';

const shim = `<script>
(function(){
  var data = ${JSON.stringify(seed)};
  var mem = {};
  try {
    Object.defineProperty(window, 'localStorage', { configurable: true, value: {
      getItem: function(k){ return Object.prototype.hasOwnProperty.call(mem,k) ? mem[k] : null; },
      setItem: function(k,v){ mem[k] = String(v); },
      removeItem: function(k){ delete mem[k]; },
      clear: function(){ mem = {}; }
    }});
  } catch (e) {}
  localStorage.setItem('dschat.v1', JSON.stringify(data));
})();
</script>`;

const clickScript = (id) => `<script>setTimeout(function(){
  var b = document.getElementById('${id}'); if (b) b.click();
}, 350);</script>`;

const afterScript = (js) => `<script>setTimeout(function(){ ${js} }, 420);</script>`;

function write(name, { withSeed, click, after, seedOverride }) {
  let html = base;
  let inject = '';
  if (withSeed) inject += seedOverride ? shimOf(seedOverride) : shim;
  if (click) inject += clickScript(click);
  if (after) inject += afterScript(after);
  if (inject) html = html.replace('</body>', inject + '</body>');
  fs.writeFileSync(path.join(OUT, name), html);
  console.log(name);
}

function shimOf(data) {
  return shim.replace(
    /var data = [\s\S]*?;\n  var mem/,
    'var data = ' + JSON.stringify(data) + ';\n  var mem'
  );
}

const lightSeed = JSON.parse(JSON.stringify(seed));
lightSeed.settings.theme = 'light';

write('chat.html', { withSeed: true });
write('top.html', { withSeed: true, after: "document.getElementById('chat').scrollTop = 0;" });
write('think.html', {
  withSeed: true,
  after:
    "document.querySelectorAll('details.think').forEach(function(d){d.open=true}); document.getElementById('chat').scrollTop = document.getElementById('chat').scrollHeight;"
});
write('light.html', {
  withSeed: true,
  seedOverride: lightSeed,
  after: "document.getElementById('chat').scrollTop = document.getElementById('chat').scrollHeight;"
});
write('empty.html', { withSeed: false });
write('settings.html', { withSeed: true, click: 'openSettings' });
write('drawer.html', { withSeed: true, click: 'openDrawer' });

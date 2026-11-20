/* 单元 / 集成测试：node _src/test.mjs */
import { createRequire } from 'node:module';
import http from 'node:http';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const app = require('./app.js');

let pass = 0,
  fail = 0;
const fails = [];

function ok(name, fn) {
  try {
    fn();
    pass++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (e) {
    fail++;
    fails.push(name);
    console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message);
  }
}
async function okAsync(name, fn) {
  try {
    await fn();
    pass++;
    console.log('  \x1b[32m✓\x1b[0m ' + name);
  } catch (e) {
    fail++;
    fails.push(name);
    console.log('  \x1b[31m✗\x1b[0m ' + name + '\n      ' + e.message);
  }
}

/* ---------- mock server ---------- */
function mock(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(body);
        } catch (e) {}
        handler(req, res, json);
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      resolve({ srv, url: `http://127.0.0.1:${port}/chat/completions`, port });
    });
  });
}

const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function streamOK(res, parts, opts = {}) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  let i = 0;
  const next = () => {
    if (i >= parts.length) {
      res.end();
      return;
    }
    res.write(parts[i++]);
    setTimeout(next, opts.delay || 1);
  };
  next();
}

/* ================= tests ================= */

console.log('\n\x1b[1m1. 工具函数\x1b[0m');

ok('esc 转义 HTML 特殊字符', () => {
  assert.equal(app.esc('<a href="x">&</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  assert.equal(app.esc(null), '');
  assert.equal(app.esc(undefined), '');
});

ok('estTokens 同字符数下中文密度高于英文', () => {
  const cn = app.estTokens([{ content: '汉字'.repeat(50) }]); // 100 字
  const en = app.estTokens([{ content: 'a'.repeat(100) }]); // 100 字符
  assert.ok(cn > en, `中文 ${cn} 应大于英文 ${en}`);
  assert.ok(cn > 0 && cn < 400, '估算应在合理范围: ' + cn);
});

ok('每次请求注入当前时间', () => {
  const msgs = app.buildApiMessages(
    { messages: [{ role: 'user', content: '今天几号', ts: 1 }] },
    { system: '你是朋友' },
    0,
    999999
  );
  const sys = msgs[0].content;
  assert.equal(msgs[0].role, 'system');
  assert.ok(/【当前时间】\d{4}年\d{1,2}月\d{1,2}日 星期[日一二三四五六]/.test(sys), sys);
  assert.ok(sys.indexOf('【当前时间】') < sys.indexOf('你是朋友'), '时间在最前');
  assert.ok(/\d{2}:\d{2}/.test(sys), '带具体时分');
});

ok('朗读前清洗 Markdown', () => {
  const t = app.stripForSpeech(
    '## 标题\n\n**粗体** 和 `inline` 和 [链接](https://x.com)\n\n```js\nconsole.log(1)\n```'
  );
  assert.ok(!t.includes('**'), '去掉粗体标记');
  assert.ok(!t.includes('`'), '去掉反引号');
  assert.ok(!t.includes('#'), '去掉标题井号');
  assert.ok(!t.includes('https://'), '去掉链接地址');
  assert.ok(t.includes('粗体') && t.includes('inline') && t.includes('链接'), '保留可读文本');
  assert.ok(t.includes('代码'), '代码块替换成一句提示');
});

ok('位置注入 system，可关闭', () => {
  const conv = { messages: [{ role: 'user', content: '今天热吗', ts: 1 }] };
  const on = app.buildApiMessages(conv, { geo: { city: '杭州市', district: '拱墅区', on: true } }, 0, 999999);
  assert.ok(on[0].content.includes('【用户位置】杭州市 拱墅区'), on[0].content.slice(0, 200));
  const off = app.buildApiMessages(conv, { geo: { city: '杭州市', district: '', on: false } }, 0, 999999);
  assert.ok(!off[0].content.includes('【用户位置】'), '关闭时不应带位置');
  const none = app.buildApiMessages(conv, { geo: { city: '', on: true } }, 0, 999999);
  assert.ok(!none[0].content.includes('【用户位置】'), '没有位置时不应带');
  const missing = app.buildApiMessages(conv, {}, 0, 999999);
  assert.ok(!missing[0].content.includes('【用户位置】'), '未设置时不应带');
});

ok('星标会话置顶且不改动原数组', () => {
  const list = [{ id: 'a' }, { id: 'b', starred: true }, { id: 'c' }, { id: 'd', starred: true }];
  const out = app.sortConvs(list);
  assert.deepEqual(out.map((x) => x.id), ['b', 'd', 'a', 'c'], '星标在前，其余保持原序');
  assert.deepEqual(list.map((x) => x.id), ['a', 'b', 'c', 'd'], '不能修改原数组');
  assert.deepEqual(app.sortConvs([]), []);
});

ok('记忆范围迁移不破坏「长记忆」', () => {
  const n = app.normalizeKeepTurns;
  assert.equal(n(0), 0, '长记忆(0)必须原样保留');
  assert.equal(n(20), 20);
  assert.equal(n(60), 60);
  assert.equal(n(10), 20, '旧值就近归到精简');
  assert.equal(n(40), 60, '旧值就近归到标准');
  assert.equal(n(100), 0, '更大的旧值归到长记忆');
  assert.equal(n(''), 60, '空值用默认');
  assert.equal(n(null), 60);
  assert.equal(n(undefined), 60);
  assert.equal(n(-1), 60);
  // 模拟一次完整的存取：选长记忆 → 重新加载
  let saved = 0;
  assert.equal(app.normalizeKeepTurns(saved), 0, '重新加载后仍是长记忆');
});

ok('fmtTokens 数字格式化', () => {
  assert.equal(app.fmtTokens(0), '0');
  assert.equal(app.fmtTokens(999), '999');
  assert.equal(app.fmtTokens(12431), '12.4K');
  assert.equal(app.fmtTokens(1000), '1K');
  assert.equal(app.fmtTokens(882000), '882K');
  assert.equal(app.fmtTokens(1000000), '1M');
  assert.equal(app.fmtTokens(1250000), '1.25M');
});

ok('isContextError 识别上下文超限', () => {
  assert.ok(app.isContextError(new Error('maximum context length is 65536 tokens')));
  assert.ok(app.isContextError({ message: 'x', detail: "This model's context length exceeded" }));
  assert.ok(!app.isContextError(new Error('rate limit')));
  assert.ok(!app.isContextError(null));
});

console.log('\n\x1b[1m2. Markdown 渲染\x1b[0m');

ok('XSS：原始 HTML 被转义', () => {
  const h = app.renderMD('<img src=x onerror=alert(1)>');
  assert.ok(!h.includes('<img'), '不应输出 img 标签: ' + h);
  assert.ok(h.includes('&lt;img'), '应转义为实体');
});

ok('XSS：script 与事件属性都被转义', () => {
  const h = app.renderMD('<script>alert(1)</script>');
  assert.ok(!/<script/i.test(h));
});

ok('标题 / 粗体 / 斜体 / 行内代码', () => {
  const h = app.renderMD('# 标题\n\n**粗** 与 *斜* 与 `code`');
  assert.ok(h.includes('<h1>标题</h1>'), h);
  assert.ok(h.includes('<strong>粗</strong>'), h);
  assert.ok(h.includes('<em>斜</em>'), h);
  assert.ok(h.includes('<code>code</code>'), h);
});

ok('代码块带语言与复制按钮', () => {
  const h = app.renderMD('```python\nprint("hi")\n```');
  assert.ok(h.includes('class="code"'), h);
  assert.ok(h.includes('class="lang">python'), h);
  assert.ok(h.includes('data-cp'), '应有复制按钮');
  assert.ok(h.includes('print(&quot;hi&quot;)'), h);
});

ok('未闭合代码块（流式）不会崩', () => {
  const h = app.renderMD('说明\n```js\nconst a = 1;');
  assert.ok(h.includes('<pre><code>'), h);
  assert.ok(h.includes('const a = 1;'), h);
});

ok('无序 / 有序列表', () => {
  const h = app.renderMD('- 甲\n- 乙\n\n1. 一\n2. 二');
  assert.ok(h.includes('<ul><li>甲</li><li>乙</li></ul>'), h);
  assert.ok(h.includes('<ol><li>一</li><li>二</li></ol>'), h);
});

ok('引用与分割线', () => {
  const h = app.renderMD('> 引用一句\n\n---');
  assert.ok(h.includes('<blockquote><p>引用一句</p></blockquote>'), h);
  assert.ok(h.includes('<hr>'), h);
});

ok('表格', () => {
  const h = app.renderMD('| A | B |\n|---|---|\n| 1 | 2 |');
  assert.ok(h.includes('<table>'), h);
  assert.ok(h.includes('<th>A</th>'), h);
  assert.ok(h.includes('<td>1</td>'), h);
});

ok('链接与裸 URL', () => {
  const h = app.renderMD('[文档](https://api.deepseek.com) 和 https://example.com/a');
  assert.ok(h.includes('<a href="https://api.deepseek.com"'), h);
  assert.ok(h.includes('href="https://example.com/a"'), h);
  assert.ok(h.includes('rel="noopener noreferrer"'), '外链需 noopener');
});

ok('段落换行保留为 <br>', () => {
  const h = app.renderMD('第一行\n第二行');
  assert.ok(h.includes('第一行<br>第二行'), h);
});

console.log('\n\x1b[1m3. SSE 解析\x1b[0m');

ok('分片跨行 / CRLF / [DONE]', () => {
  const seen = [];
  const p = app.createSSEParser((ev) => seen.push(ev));
  p.push('data: {"a":1}\r');
  p.push('\n\ndata: {"b"');
  p.push(':2}\n\n');
  p.push('data: [DONE]\n\n');
  p.end();
  assert.equal(seen.length, 3, JSON.stringify(seen));
  assert.equal(seen[0].json.a, 1);
  assert.equal(seen[1].json.b, 2);
  assert.equal(seen[2].done, true);
});

ok('忽略注释行与非法 JSON', () => {
  const seen = [];
  const p = app.createSSEParser((ev) => seen.push(ev));
  p.push(': keep-alive\n\n');
  p.push('data: not-json\n\n');
  p.push('event: ping\n\n');
  p.push('data: {"ok":true}\n\n');
  p.end();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].json.ok, true);
});

ok('无结尾换行的最后一行也会被处理', () => {
  const seen = [];
  const p = app.createSSEParser((ev) => seen.push(ev));
  p.push('data: {"last":1}');
  p.end();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].json.last, 1);
});

console.log('\n\x1b[1m4. 上下文裁剪\x1b[0m');

ok('保留 system 并限制轮数', () => {
  const conv = { messages: [] };
  for (let i = 0; i < 30; i++) {
    conv.messages.push({ role: 'user', content: 'u' + i });
    conv.messages.push({ role: 'assistant', content: 'a' + i });
  }
  const msgs = app.buildApiMessages(conv, { system: '你是助手' }, 3, 999999);
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[0].content.includes('你是助手'), '自定义 system 保留');
  const body = msgs.filter((m) => m.role !== 'system');
  assert.ok(body.length <= 6, '3 轮应最多 6 条，实际 ' + body.length);
  assert.equal(body[0].role, 'user', '裁剪后必须从 user 开始');
  assert.ok(body[body.length - 1].content === 'a29');
});

ok('上下文保留图片块', () => {
  const conv = {
    messages: [
      { role: 'user', content: '看图', images: ['data:image/jpeg;base64,AAA'] },
      { role: 'assistant', content: '看到了' },
      { role: 'user', content: '', images: ['data:image/jpeg;base64,BBB'] }
    ]
  };
  const msgs = app.buildApiMessages(conv, {}, 20, 999999).filter((m) => m.role !== 'system');
  assert.equal(msgs.length, 3);
  assert.deepEqual(msgs[0].images, ['data:image/jpeg;base64,AAA']);
  assert.ok(msgs[2].images && msgs[2].images.length, '纯图片消息不应被丢弃');
});

ok('keepTurns=0：不按轮数裁剪，只受预算约束', () => {
  const conv = { messages: [] };
  for (let i = 0; i < 100; i++) {
    conv.messages.push({ role: 'user', content: 'u' + i });
    conv.messages.push({ role: 'assistant', content: 'a' + i });
  }
  const all = app.buildApiMessages(conv, {}, 0, 999999).filter((m) => m.role !== 'system');
  assert.equal(all.length, 200, '长记忆应保留全部 200 条');
  assert.equal(all[0].content, 'u0');
  const limited = app.buildApiMessages(conv, {}, 20, 999999).filter((m) => m.role !== 'system');
  assert.equal(limited.length, 40, '20 轮 = 40 条');
  const tight = app.buildApiMessages(conv, {}, 0, 400).filter((m) => m.role !== 'system');
  assert.ok(app.estTokens(tight) <= 800, '预算仍生效');
  assert.equal(tight[tight.length - 1].content, 'a99', '最新一条必须保留');
});

ok('长期记忆注入 system，cutoff 之前的消息不再发送', () => {
  const conv = {
    cutoff: 1000,
    memory: { text: '【用户信息】小林，后端工程师' },
    messages: [
      { role: 'user', content: '旧问题', ts: 500 },
      { role: 'assistant', content: '旧回答', ts: 600 },
      { role: 'user', content: '新问题', ts: 1001 },
      { role: 'assistant', content: '新回答', ts: 1002 }
    ]
  };
  const msgs = app.buildApiMessages(conv, { system: '你是朋友' }, 0, 999999);
  assert.equal(msgs[0].role, 'system');
  assert.ok(msgs[0].content.includes('你是朋友'), '原 system 保留');
  assert.ok(msgs[0].content.includes('这是你自己的记忆'), '明确是自身经历');
  assert.ok(msgs[0].content.includes('你一直在和同一个人聊天'), '身份延续说明');
  assert.ok(msgs[0].content.includes('不要说自己刚认识对方'), '禁止失忆式开场');
  assert.ok(msgs[0].content.includes('小林'), '记忆内容在内');
  assert.ok(msgs.some((m) => m.content === '新问题'));
  assert.ok(!msgs.some((m) => m.content === '旧问题'), '旧消息应被裁掉');
});

ok('cutoff 失效时有兜底，不会把对话清空', () => {
  const conv = {
    cutoff: 999999,
    messages: [{ role: 'user', content: '唯一的消息', ts: 100 }]
  };
  const msgs = app.buildApiMessages(conv, {}, 0, 999999);
  assert.ok(msgs.length >= 1);
  assert.equal(msgs[msgs.length - 1].content, '唯一的消息');
});

ok('压缩提示词分四段，且随详细程度变化', () => {
  const brief = app.buildCompactPrompt('', [{ role: 'user', content: 'x' }], 'brief');
  const rich = app.buildCompactPrompt('', [{ role: 'user', content: 'x' }], 'rich');
  assert.ok(rich.includes('【用户信息】') && rich.includes('【重要往事】'));
  assert.ok(rich.includes('【最近发生的事】') && rich.includes('【相处方式】'));
  assert.ok(rich.includes('最多 20 条'), '详细档应允许 20 条往事');
  assert.ok(brief.includes('最多 5 条'), '简要档只留 5 条');
  assert.ok(rich.includes('80 字'), '详细档单条更长');
});

ok('压缩提示词带上旧记忆与原文', () => {
  const p = app.buildCompactPrompt('【用户信息】养了一只猫叫豆豆', [
    { role: 'user', content: '今天加班到十点' },
    { role: 'assistant', content: '辛苦了' }
  ]);
  assert.ok(p.includes('长期记忆整理助手'), '有角色设定');
  assert.ok(p.includes('豆豆'), '旧记忆并入');
  assert.ok(p.includes('用户：今天加班到十点'), '对话原文在内');
  assert.ok(p.includes('助手：辛苦了'));
  assert.ok(p.includes('【用户信息】') && p.includes('【最近发生的事】'), '输出格式约定');
});

ok('跳过报错消息', () => {
  const conv = {
    messages: [
      { role: 'user', content: '在吗' },
      { role: 'assistant', content: '', error: '网络失败' },
      { role: 'user', content: '再试' }
    ]
  };
  const msgs = app.buildApiMessages(conv, {}, 20, 999999).filter((m) => m.role !== 'system');
  assert.equal(msgs.length, 2);
  assert.ok(msgs.every((m) => !m.error));
});

ok('超出预算时丢弃最旧消息', () => {
  const conv = { messages: [] };
  for (let i = 0; i < 40; i++) {
    conv.messages.push({ role: 'user', content: '长'.repeat(200) + i });
    conv.messages.push({ role: 'assistant', content: '答'.repeat(200) });
  }
  const msgs = app.buildApiMessages(conv, {}, 40, 600);
  assert.ok(app.estTokens(msgs) <= 1200, '应显著裁剪，实际 ' + app.estTokens(msgs));
  assert.ok(msgs.length >= 2, '不能裁到空: ' + msgs.length);
  assert.equal(
    msgs[msgs.length - 1].content,
    conv.messages[conv.messages.length - 1].content,
    '必须保留最新的那条消息'
  );
});

console.log('\n\x1b[1m5. streamChat 端到端（本地 mock）\x1b[0m');

await okAsync('正常流式：reasoning + content + usage', async () => {
  const { srv, url } = await mock((req, res) => {
    const parts = [
      sse({ choices: [{ delta: { reasoning_content: '先想' } }] }),
      sse({ choices: [{ delta: { reasoning_content: '一下' } }] }),
      sse({ choices: [{ delta: { content: '你' } }] }),
      sse({ choices: [{ delta: { content: '好' } }] }),
      sse({ choices: [{ delta: { content: '' }, finish_reason: 'stop' }] }),
      sse({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 4 } }),
      'data: [DONE]\n\n'
    ];
    parts[2] = parts[2].slice(0, 20) + parts[2].slice(20); // 保证跨块
    streamOK(res, parts);
  });
  try {
    let rSnap = '',
      cSnap = '',
      usage = null;
    const r = await app.streamChat({
      apiKey: 'sk-test',
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      endpoint: url,
      temperature: 1.0,
      onReasoning: (x) => (rSnap = x),
      onContent: (x) => (cSnap = x),
      onUsage: (u) => (usage = u)
    });
    assert.equal(r.content, '你好');
    assert.equal(r.reasoning, '先想一下');
    assert.equal(cSnap, '你好');
    assert.equal(rSnap, '先想一下');
    assert.equal(usage.prompt_tokens, 11);
  } finally {
    srv.close();
  }
});

await okAsync('UTF-8 多字节字符被切成两半也能拼回', async () => {
  const payload = Buffer.from(
    sse({ choices: [{ delta: { content: '中文👋emoji' } }] }) + 'data: [DONE]\n\n'
  );
  const { srv, url } = await mock((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    // 在 emoji 中间切一刀
    let cut = payload.indexOf(Buffer.from('👋'));
    cut += 2;
    res.write(payload.subarray(0, cut));
    setTimeout(() => {
      res.write(payload.subarray(cut));
      res.end();
    }, 10);
  });
  try {
    const r = await app.streamChat({
      apiKey: 'k',
      model: 'deepseek-chat',
      endpoint: url,
      messages: [{ role: 'user', content: 'x' }]
    });
    assert.equal(r.content, '中文👋emoji');
  } finally {
    srv.close();
  }
});

await okAsync('401 抛出友好错误', async () => {
  const { srv, url } = await mock((req, res) => {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Authentication Fails' } }));
  });
  try {
    await assert.rejects(
      () =>
        app.streamChat({
          apiKey: 'bad',
          model: 'deepseek-chat',
          endpoint: url,
          messages: [{ role: 'user', content: 'x' }]
        }),
      (e) => {
        assert.equal(e.status, 401);
        assert.ok(/API Key/.test(e.message), e.message);
        assert.equal(e.detail, 'Authentication Fails');
        return true;
      }
    );
  } finally {
    srv.close();
  }
});

await okAsync('402 余额不足', async () => {
  const { srv, url } = await mock((req, res) => {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Insufficient Balance' } }));
  });
  try {
    await assert.rejects(
      () =>
        app.streamChat({
          apiKey: 'k',
          model: 'deepseek-chat',
          endpoint: url,
          messages: [{ role: 'user', content: 'x' }]
        }),
      (e) => {
        assert.equal(e.status, 402);
        assert.ok(/余额/.test(e.message));
        return true;
      }
    );
  } finally {
    srv.close();
  }
});

await okAsync('服务端拒绝 stream_options 时自动降级重试', async () => {
  const bodies = [];
  const { srv, url } = await mock((req, res, json) => {
    bodies.push(json);
    if (bodies.length === 1) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { message: 'Unrecognized request argument supplied: stream_options' }
        })
      );
      return;
    }
    streamOK(res, [sse({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n']);
  });
  try {
    const r = await app.streamChat({
      apiKey: 'k',
      model: 'deepseek-chat',
      endpoint: url,
      messages: [{ role: 'user', content: 'x' }]
    });
    assert.equal(r.content, 'ok');
    assert.equal(bodies.length, 2, '应请求两次');
    assert.ok(bodies[0].stream_options, '第一次带 stream_options');
    assert.ok(!bodies[1].stream_options, '第二次不带');
  } finally {
    srv.close();
  }
});

await okAsync('思考模式：开=thinking+effort，关=temperature', async () => {
  const bodies = [];
  const { srv, url } = await mock((req, res, json) => {
    bodies.push(json);
    streamOK(res, [sse({ choices: [{ delta: { content: 'x' } }] }), 'data: [DONE]\n\n']);
  });
  try {
    await app.streamChat({
      apiKey: 'k',
      model: 'deepseek-flash',
      endpoint: url,
      thinking: true,
      effort: 'max',
      temperature: 1.2,
      messages: [{ role: 'user', content: 'x' }]
    });
    assert.deepEqual(bodies[0].thinking, { type: 'enabled' });
    assert.equal(bodies[0].reasoning_effort, 'max');
    assert.equal(bodies[0].temperature, undefined, '思考模式下不应带 temperature');

    await app.streamChat({
      apiKey: 'k',
      model: 'deepseek-flash',
      endpoint: url,
      thinking: false,
      temperature: 0.7,
      messages: [{ role: 'user', content: 'x' }]
    });
    assert.deepEqual(bodies[1].thinking, { type: 'disabled' });
    assert.equal(bodies[1].temperature, 0.7);
    assert.equal(bodies[1].reasoning_effort, undefined, '关闭思考不应带 effort');
  } finally {
    srv.close();
  }
});

await okAsync('图片消息转成 image_url 内容块', async () => {
  let seen = null;
  const { srv, url } = await mock((req, res, json) => {
    seen = json;
    streamOK(res, [sse({ choices: [{ delta: { content: '看到了' } }] }), 'data: [DONE]\n\n']);
  });
  try {
    await app.streamChat({
      apiKey: 'k',
      model: 'deepseek-flash',
      endpoint: url,
      messages: [{ role: 'user', content: '这是什么', images: ['data:image/jpeg;base64,AAAA'] }]
    });
    const c = seen.messages[0].content;
    assert.ok(Array.isArray(c), 'content 应为数组');
    assert.equal(c[0].type, 'text');
    assert.equal(c[0].text, '这是什么');
    assert.equal(c[1].type, 'image_url');
    assert.ok(c[1].image_url.url.startsWith('data:image/jpeg;base64,'), c[1].image_url.url);
  } finally {
    srv.close();
  }
});

await okAsync('纯图片消息（无文字）也能发出', async () => {
  let seen = null;
  const { srv, url } = await mock((req, res, json) => {
    seen = json;
    streamOK(res, [sse({ choices: [{ delta: { content: 'ok' } }] }), 'data: [DONE]\n\n']);
  });
  try {
    await app.streamChat({
      apiKey: 'k',
      model: 'deepseek-flash',
      endpoint: url,
      messages: [{ role: 'user', content: '', images: ['data:image/png;base64,BBBB'] }]
    });
    const c = seen.messages[0].content;
    assert.equal(c.length, 1, '只有图片块');
    assert.equal(c[0].type, 'image_url');
  } finally {
    srv.close();
  }
});

await okAsync('输出被内容安全拦截 → BLOCKED', async () => {
  const { srv, url } = await mock((req, res) => {
    streamOK(res, [
      sse({ choices: [{ delta: { content: '这是一段' } }] }),
      sse({ choices: [{ delta: {}, finish_reason: 'content_filter' }] }),
      'data: [DONE]\n\n'
    ]);
  });
  try {
    await assert.rejects(
      () => app.streamChat({ apiKey: 'k', model: 'deepseek-flash', endpoint: url, messages: [{ role: 'user', content: 'x' }] }),
      (e) => {
        assert.equal(e.code, 'BLOCKED');
        assert.ok(/安全策略/.test(e.message), e.message);
        return true;
      }
    );
  } finally { srv.close(); }
});

await okAsync('输入被拦截（400 Content Exists Risk）', async () => {
  const { srv, url } = await mock((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Content Exists Risk' } }));
  });
  try {
    await assert.rejects(
      () => app.streamChat({ apiKey: 'k', model: 'deepseek-flash', endpoint: url, messages: [{ role: 'user', content: 'x' }] }),
      (e) => {
        assert.equal(e.code, 'BLOCKED');
        assert.ok(/安全策略/.test(e.message), e.message);
        return true;
      }
    );
  } finally { srv.close(); }
});

await okAsync('锁定默认安全档：请求里不带 safety_check', async () => {
  let seen = null;
  const { srv, url } = await mock((req, res, json) => {
    seen = json;
    streamOK(res, [sse({ choices: [{ delta: { content: 'x' } }] }), 'data: [DONE]\n\n']);
  });
  try {
    await app.streamChat({ apiKey: 'k', model: 'deepseek-flash', endpoint: url, messages: [{ role: 'user', content: 'x' }], web: true });
    assert.equal(seen.safety_check, undefined, '不得发送 safety_check');
  } finally { srv.close(); }
});

await okAsync('联网：声明服务端工具并解析引用', async () => {
  let seen = null;
  const { srv, url } = await mock((req, res, json) => {
    seen = json;
    streamOK(res, [
      sse({ choices: [{ delta: { content: '冰岛人口约 39 万。' } }] }),
      sse({ choices: [{ delta: {
        annotations: [
          { type: 'url_citation', url_citation: { url: 'https://a.com/x', title: 'A 网站', start_index: 0, end_index: 5 } },
          { type: 'url_citation', url_citation: { url: 'https://a.com/x', title: 'A 网站', start_index: 6, end_index: 9 } }
        ],
        server_tool_calls: [
          { index: 0, calls: [{ index: 0, type: 'deepseek_web_search', kind: 'search', action: { type: 'search', queries: ['iceland population'] }, status: 'completed' }] }
        ]
      }, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n'
    ]);
  });
  try {
    const r = await app.streamChat({
      apiKey: 'k', model: 'deepseek-flash', endpoint: url, web: true,
      messages: [{ role: 'user', content: '冰岛人口' }]
    });
    assert.deepEqual(seen.tools, [{ type: 'deepseek_web_search' }, { type: 'deepseek_read_url' }], '应声明两个工具');
    assert.equal(r.searched, true, '应标记为联网过');
    assert.equal(r.citations.length, 1, '同一 URL 应去重');
    assert.equal(r.citations[0].url, 'https://a.com/x');
    assert.equal(r.content, '冰岛人口约 39 万。');
  } finally { srv.close(); }
});

await okAsync('联网：读链接的来源也算引用', async () => {
  const { srv, url } = await mock((req, res) => {
    streamOK(res, [
      sse({ choices: [{ delta: { content: '看过了。' } }] }),
      sse({ choices: [{ delta: { server_tool_calls: [
        { index: 0, calls: [{ index: 0, type: 'deepseek_read_url', kind: 'read_link',
          action: { type: 'read_link', url: 'https://b.com/p' },
          status: 'completed', page: { url: 'https://b.com/p', title: 'B 的文章' } }] }
      ] }, finish_reason: 'stop' }] }),
      'data: [DONE]\n\n'
    ]);
  });
  try {
    const r = await app.streamChat({
      apiKey: 'k', model: 'deepseek-flash', endpoint: url, web: true,
      messages: [{ role: 'user', content: '总结 https://b.com/p' }]
    });
    assert.equal(r.searched, true);
    assert.equal(r.citations[0].url, 'https://b.com/p');
    assert.equal(r.citations[0].title, 'B 的文章');
  } finally { srv.close(); }
});

await okAsync('未开启联网时不声明 tools', async () => {
  let seen = null;
  const { srv, url } = await mock((req, res, json) => {
    seen = json;
    streamOK(res, [sse({ choices: [{ delta: { content: 'x' } }] }), 'data: [DONE]\n\n']);
  });
  try {
    await app.streamChat({ apiKey: 'k', model: 'deepseek-flash', endpoint: url, messages: [{ role: 'user', content: 'x' }] });
    assert.equal(seen.tools, undefined, '不该带 tools');
  } finally { srv.close(); }
});

await okAsync('空回答 → 抛 EMPTY', async () => {
  const { srv, url } = await mock((req, res) => {
    streamOK(res, ['data: [DONE]\n\n']);
  });
  try {
    await assert.rejects(
      () =>
        app.streamChat({
          apiKey: 'k',
          model: 'deepseek-chat',
          endpoint: url,
          messages: [{ role: 'user', content: 'x' }]
        }),
      (e) => {
        assert.equal(e.code, 'EMPTY');
        return true;
      }
    );
  } finally {
    srv.close();
  }
});

await okAsync('中止请求 → AbortError', async () => {
  const { srv, url } = await mock((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(sse({ choices: [{ delta: { content: 'a' } }] }));
    // 永不结束
  });
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    await assert.rejects(
      () =>
        app.streamChat({
          apiKey: 'k',
          model: 'deepseek-chat',
          endpoint: url,
          signal: ac.signal,
          messages: [{ role: 'user', content: 'x' }]
        }),
      (e) => {
        assert.equal(e.name, 'AbortError');
        return true;
      }
    );
  } finally {
    srv.close();
  }
});

await okAsync('网络不可达 → 友好提示', async () => {
  await assert.rejects(
    () =>
      app.streamChat({
        apiKey: 'k',
        model: 'deepseek-chat',
        endpoint: 'http://127.0.0.1:1/chat/completions',
        messages: [{ role: 'user', content: 'x' }]
      }),
    (e) => {
      assert.equal(e.code, 'NETWORK');
      assert.ok(/网络/.test(e.message));
      return true;
    }
  );
});

/* ---------- summary ---------- */
console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
if (fail) {
  console.log('失败用例：', fails.join(' / '));
  process.exit(1);
}

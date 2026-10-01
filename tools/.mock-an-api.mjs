// tools/.mock-an-api.mjs —— 给本地 auto-novel 前端(dev server)用的极简 mock API
// 只为把 BETA 工作区页面喂起来：/api/novel/{provider}/{novelId}/translate-v2/gpt → 合成 TOC
// 环境变量: MOCK_PORT(默认 8789) MOCK_CHAPTERS(默认 113) MOCK_DELAY_MS(默认 200) MOCK_SLOTS(默认 1, 模拟上游并发槽位)
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT || 8789);
const CHAPTERS = Number(process.env.MOCK_CHAPTERS || 113);
const DELAY = Number(process.env.MOCK_DELAY_MS || 200);
const SLOTS = Number(process.env.MOCK_SLOTS || 1);

let inflight = 0;
const waiters = [];
const acquire = () =>
  new Promise((res) => {
    if (inflight < SLOTS) { inflight++; res(); } else waiters.push(res);
  });
const release = () => { const w = waiters.shift(); if (w) w(); else inflight--; };

let reqCount = 0;
const toc = Array.from({ length: CHAPTERS }, (_, i) => ({
  chapterId: 'c' + (i + 1),
  titleJp: '第' + (i + 1) + '話 タイトル' + (i + 1),
}));

const server = http.createServer(async (req, res) => {
  reqCount++;
  const u = new URL(req.url, 'http://x');
  if (/\/translate-v2\/[^/]+$/.test(u.pathname)) {
    // 模拟线上行为：并发越高，每个请求被拖得越慢（实测单人 1-2s、40 并发时 18-21s）
    await acquire();
    const inflightNow = Math.max(1, inflight);
    await new Promise((r) => setTimeout(r, DELAY * inflightNow));
    try {
      const parts = u.pathname.split('/');
      const novelId = parts[3] || 'mock-novel';
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        titleJp: 'mock:' + novelId,
        introductionJp: 'mock introduction',
        glossaryUuid: 'g-' + novelId,
        glossary: {},
        toc,
      }));
    } finally { release(); }
    return;
  }
  if (u.pathname === '/__stats') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ reqCount, inflight, waiting: waiters.length }));
    return;
  }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{}');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock-an-api on http://127.0.0.1:${PORT} chapters=${CHAPTERS} delay=${DELAY}ms slots=${SLOTS}`);
});

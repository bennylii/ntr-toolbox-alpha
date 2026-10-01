const out = { checks: [], errors: [] };
try {
  // 不依赖注入副本的调试句柄（篡改猴沙箱下页面上下文取不到），直接用页面 fetch
  const j = async (url) => { const r = await fetch(url, { credentials: 'same-origin' }); return r.ok ? await r.json() : { __http: r.status }; };
  const wenku = await j('/api/wenku/6aad7f8e697f727137ebc7f6');
  out.checks.push({ what: '文库 glossary', n: Object.keys(wenku.glossary || {}).length, keys: Object.keys(wenku.glossary || {}).slice(0, 5) });
  const web = await j('/api/novel/syosetu/n0284mu');
  out.checks.push({ what: '网页小说 glossary', n: Object.keys(web.glossary || {}).length, keys: Object.keys(web.glossary || {}).slice(0, 5) });
  const his = await j('/api/user/read-history');
  const list = Array.isArray(his) ? his : (his.content || his.list || []);
  out.checks.push({ what: '阅读历史', n: list.length, testish: list.filter((h) => JSON.stringify(h).includes('テスト') || JSON.stringify(h).includes('测试')).length });
  const favWeb = await j('/api/favorite/web');
  const favWenku = await j('/api/favorite/wenku');
  out.checks.push({ what: '收藏夹(web/wenku)', n: [ (favWeb||[]).length, (favWenku||[]).length ] });
} catch (e) { out.errors.push(String(e && (e.stack || e.message))); }
return JSON.stringify(out, null, 1);

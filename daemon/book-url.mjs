// daemon/book-url.mjs —— 书 URL 解析（CLI 与控面共用）
export function parseBookUrl(url) {
  const m = /\/(novel|wenku)\/([^/?#]+)(?:\/([^/?#]+))?/.exec(String(url || ''));
  if (!m) throw new Error('无法从 URL 解析书籍（需要 /novel/{provider}/{id} 或 /wenku/{id}）');
  if (m[1] === 'novel') return { kind: 'web', providerId: m[2], novelId: m[3], key: `web:${m[2]}/${m[3]}` };
  return { kind: 'wenku', providerId: '', novelId: m[2], key: `wenku:${m[2]}` };
}

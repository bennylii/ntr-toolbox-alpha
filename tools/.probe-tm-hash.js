// 算 TM 存储里已安装 dev 脚本正文的 sha256（与本地文件比对）
const out = {};
try {
  const all = await chrome.storage.local.get(null);
  const stored = all['!extdb.@source#eb55c4b2-2369-4bd5-a180-ceb07a006327'].value;
  const buf = new TextEncoder().encode(stored);
  const dig = await crypto.subtle.digest('SHA-256', buf);
  out.len = stored.length;
  out.bytes = buf.length;
  out.sha256 = Array.from(new Uint8Array(dig)).map((b) => b.toString(16).padStart(2, '0')).join('');
  out.crlf = (stored.match(/\r\n/g) || []).length;
  out.lf = (stored.match(/(?<!\r)\n/g) || []).length;
  return JSON.stringify(out, null, 1);
} catch (e) { return JSON.stringify({ err: String((e && e.stack) || e) }, null, 1); }

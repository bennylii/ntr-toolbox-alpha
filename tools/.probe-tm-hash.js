// 算 TM 存储里所有已安装用户脚本正文的 sha256（与本地文件比对；不依赖固定 uuid key）
const out = {};
try {
    const all = await chrome.storage.local.get(null);
    const sources = Object.entries(all).filter(([k]) => k.startsWith('!extdb.@source#'));
    out.scripts = [];
    for (const [k, entry] of sources) {
        const stored = entry && entry.value;
        if (typeof stored !== 'string') continue;
        const buf = new TextEncoder().encode(stored);
        const dig = await crypto.subtle.digest('SHA-256', buf);
        const name = (stored.match(/^\/\/ @name\s+(.+)$/m) || [])[1] || '?';
        out.scripts.push({
            key: k,
            name: name.trim(),
            len: stored.length,
            sha256: Array.from(new Uint8Array(dig)).map((b) => b.toString(16).padStart(2, '0')).join(''),
        });
    }
    return JSON.stringify(out, null, 1);
} catch (e) { return JSON.stringify({ err: String((e && e.stack) || e) }, null, 1); }

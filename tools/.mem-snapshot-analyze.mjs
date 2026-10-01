// tools/.mem-snapshot-analyze.mjs —— .heapsnapshot 归因
//   node tools/.mem-snapshot-analyze.mjs <file>            单份报告（自持大小按构造函数/类型汇总）
//   node tools/.mem-snapshot-analyze.mjs --diff <a> <b>    两份对比（b - a，按类目）——注意 V8 自持大小不含对象属性存储
import fs from 'node:fs';

const MB = (n) => +(n / 1048576).toFixed(2);

const scan = (file) => {
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  const meta = snap.snapshot.meta;
  const NF = meta.node_fields.length;
  const nodeTypes = meta.node_types[0];
  const iType = meta.node_fields.indexOf('type');
  const iName = meta.node_fields.indexOf('name');
  const iSize = meta.node_fields.indexOf('self_size');
  const nodes = snap.nodes, strings = snap.strings;
  const nodeCount = snap.snapshot.node_count;

  const STRINGY = new Set(['string', 'concatenated string', 'sliced string']);
  const byName = new Map();
  const byType = new Map();
  let strBytes = 0, strCount = 0, totalBytes = 0;

  for (let i = 0; i < nodeCount; i++) {
    const off = i * NF;
    const t = nodeTypes[nodes[off + iType]];
    const size = nodes[off + iSize] || 0;
    totalBytes += size;
    const te = byType.get(t) || { count: 0, bytes: 0 };
    te.count++; te.bytes += size; byType.set(t, te);
    if (STRINGY.has(t)) { strBytes += size; strCount++; continue; }
    const nameIdx = nodes[off + iName];
    const nm = (t === 'array' || t === 'hidden' || t === 'object shape')
      ? '[' + (strings[nameIdx] || ('#' + nameIdx)) + ']'
      : (strings[nameIdx] || ('#' + nameIdx));
    const key = t + ':' + nm;
    const e = byName.get(key) || { count: 0, bytes: 0, type: t, name: nm };
    e.count++; e.bytes += size; byName.set(key, e);
  }
  return {
    file, fileBytes: fs.statSync(file).size, nodeCount, totalBytes,
    strBytes, strCount, byName, byType,
  };
};

const single = (file) => {
  const s = scan(file);
  const list = [...s.byName.values()].sort((a, b) => b.bytes - a.bytes);
  console.log(JSON.stringify({
    file: s.file, fileMB: MB(s.fileBytes), nodeCount: s.nodeCount, totalSelfMB: MB(s.totalBytes),
    strings: { count: s.strCount, mb: MB(s.strBytes) },
    byType: [...s.byType.entries()].map(([t, v]) => ({ type: t, count: v.count, mb: MB(v.bytes) })).sort((a, b) => b.mb - a.mb),
    topByBytes: list.slice(0, 22).map((e) => ({ type: e.type, name: e.name, count: e.count, mb: MB(e.bytes) })),
    topByCount: [...list].sort((a, b) => b.count - a.count).slice(0, 14).map((e) => ({ type: e.type, name: e.name, count: e.count, mb: MB(e.bytes) })),
  }, null, 2));
};

const diff = (fa, fb) => {
  const A = scan(fa);
  const B = scan(fb);
  const keys = new Set([...A.byName.keys(), ...B.byName.keys()]);
  const rows = [];
  for (const k of keys) {
    const a = A.byName.get(k) || { count: 0, bytes: 0, type: '', name: k };
    const b = B.byName.get(k) || { count: 0, bytes: 0, type: '', name: k };
    const dCount = b.count - a.count, dBytes = b.bytes - a.bytes;
    if (Math.abs(dBytes) < 150000 && Math.abs(dCount) < 200) continue;
    rows.push({ type: b.type || a.type, name: b.name || a.name, aCount: a.count, bCount: b.count, dCount, dMB: MB(dBytes) });
  }
  rows.sort((x, y) => y.dMB - x.dMB);
  console.log(JSON.stringify({
    a: { file: A.file, nodeCount: A.nodeCount, totalSelfMB: MB(A.totalBytes), strMB: MB(A.strBytes), strCount: A.strCount },
    b: { file: B.file, nodeCount: B.nodeCount, totalSelfMB: MB(B.totalBytes), strMB: MB(B.strBytes), strCount: B.strCount },
    delta: {
      nodeCount: B.nodeCount - A.nodeCount,
      totalSelfMB: MB(B.totalBytes - A.totalBytes),
      strMB: MB(B.strBytes - A.strBytes),
      strCount: B.strCount - A.strCount,
    },
    rows: rows.slice(0, 40),
  }, null, 2));
};

const [cmd, f1, f2] = process.argv.slice(2);
if (cmd === '--diff') diff(f1, f2);
else single(cmd);

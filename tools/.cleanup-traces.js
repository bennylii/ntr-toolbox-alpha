const out = { done: [], errors: [] };
const volumeId = 'jp.测试卷.测试用.txt';
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
try {
  // 1) 站点本地卷（测试 profile 的 volumes@2）：三个 store 都清
  const vdb = await new Promise((res, rej) => { const r = indexedDB.open('volumes', 2); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  for (const store of ['metadata', 'chapter', 'file']) {
    const tx = vdb.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    const keys = await reqP(s.getAllKeys());
    let n = 0;
    for (const k of keys) { if (String(k).includes(volumeId)) { s.delete(k); n++; } }
    await new Promise((res) => { tx.oncomplete = res; tx.onerror = res; });
    out.done.push(`volumes@2/${store}: 删除 ${n} 条`);
  }
  // 2) 脚本 IDB：snapshots / jobs / chunks 全清（都是本轮测试产物）
  const gdb = await new Promise((res, rej) => { const r = indexedDB.open('ntr-glossary', 1); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  for (const store of ['snapshots', 'jobs', 'chunks']) {
    const tx = gdb.transaction(store, 'readwrite');
    const s = tx.objectStore(store);
    const keys = await reqP(s.getAllKeys());
    for (const k of keys) s.delete(k);
    await new Promise((res) => { tx.oncomplete = res; tx.onerror = res; });
    out.done.push(`ntr-glossary/${store}: 清空 ${keys.length} 条`);
  }
  // 3) localStorage 配置：把测试用的术语表/剪贴板设置复位
  const raw = localStorage.getItem('NTR_ToolBox_Config');
  if (raw) {
    const cfg = JSON.parse(raw);
    const mod = (cfg.modules || []).find((m) => m.name === '导入术语表(KWG)');
    if (mod) {
      const s1 = mod.settings.find((s) => s.name === '术语表'); if (s1) s1.value = '';
      const s2 = mod.settings.find((s) => s.name === '读取剪贴板'); if (s2) s2.value = false;
    }
    const ext = (cfg.modules || []).find((m) => m.name === 'AI提取术语表');
    if (ext) {
      const s = ext.settings.find((x) => x.name === '模式'); if (s) s.value = '预览';
    }
    localStorage.setItem('NTR_ToolBox_Config', JSON.stringify(cfg));
    out.done.push('localStorage: 导入术语表=空 / 读取剪贴板=false / 提取模式=预览');
  }
  // 4) 复查：本地卷列表应为空
  const Dev = window._NTRGlossaryDev;   // 篡改猴沙箱副本下页面上下文取不到，跳过复查不报错
  if (Dev) {
    out.localVolumes = (await Dev.GlossaryTargets.listLocalVolumes()).map((v) => v.id);
    out.snapshots = (await Dev.GlossaryDB.getAll('snapshots')).length;
  } else {
    out.localVolumes = 'skipped (sandboxed injection)';
    out.snapshots = 'skipped (sandboxed injection)';
  }
} catch (e) { out.errors.push(String(e && (e.stack || e.message))); }
return JSON.stringify(out, null, 1);

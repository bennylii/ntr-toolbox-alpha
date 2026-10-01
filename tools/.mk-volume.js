// 在测试 profile 里造一个本地卷（等价站点 stores/local/CreateVolume.ts 的落库结果）
const volumeId = 'jp.测试卷.测试用.txt';
const lines = [];
for (let i = 0; i < 40; i++) {
  lines.push(`第${i}行：アリスとローズがローズ娼館で魔導書を読んでいた。`);
  lines.push(`そのときレナリスが「エリクシル」を持って現れた。`);
  lines.push(`魔導書のページには古代文字が並んでいる。`);
}
const openDb = () => new Promise((resolve, reject) => {
  const req = indexedDB.open('volumes', 2);
  req.onupgradeneeded = () => {
    const db = req.result;
    if (!db.objectStoreNames.contains('metadata')) db.createObjectStore('metadata', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('file')) db.createObjectStore('file', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('chapter')) {
      const store = db.createObjectStore('chapter', { keyPath: 'id' });
      store.createIndex('byVolumeId', 'volumeId');
    }
  };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const db = await openDb();
const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const chapterId = '0';
await reqP(db.transaction('chapter', 'readwrite').objectStore('chapter').put({
  id: `${volumeId}/${chapterId}`,
  volumeId,
  paragraphs: lines,
}));
const meta = {
  id: volumeId,
  createAt: Date.now(),
  toc: [{ chapterId }],
  glossaryId: (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())),
  glossary: {},
  favoredId: 'default',
};
await reqP(db.transaction('metadata', 'readwrite').objectStore('metadata').put(meta));
return JSON.stringify({ created: volumeId, chapters: 1, lines: lines.length, glossaryId: meta.glossaryId });

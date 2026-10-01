// 造一个"跑过但还有未覆盖行"的任务并打开队列面板 —— 用来给「已覆盖 X/Y 行 · 待 N」+「重试/重跑」文案截图
// 跑法：cdp open http://127.0.0.1:8788/wenku/mock-src + cdp inject 后 node tools/cdp.mjs evalf tools/.shot-setup.js，再 cdp shot queue-panel.png
return (async () => {
  const D = window._NTRGlossaryDev;
  const Q = D.GlossaryQueue;
  Q.stop();
  for (const j of await Q.list()) await Q.remove(j.id);
  const created = await Q.addJobs([
    { kind: 'wenku', novelId: 'mock-src', title: '文库小说 mock-src' },
  ], Q.extractSettings());
  const j = created[0];
  j.state = 'review';
  j.entries = [
    { src: 'アリス', dst: '骑薇牙亚', type: '女性人名', count: 37 },
    { src: 'ローズ', dst: '绯丝牙月', type: '女性人名', count: 37 },
    { src: '魔導書', dst: '魔莉', type: '特殊物品', count: 41 },
  ];
  j.resultCount = 3;
  j.progress = { round: 3, maxRounds: 3, chunksDone: 6, chunksFailed: 5, pendingLines: 17, totalLines: 37, coveredBase: 20, covered: 20, uncovered: 17, runLines: 37, totalChunks: 5, chunksBase: 1, timerBase: 1, roundStartedAt: Date.now() };
  j.error = '17 行未能提取（已保留其余结果）';
  await Q.put(j);
  await Q.openPanel();
  return { id: j.id };
})()

// 截图用：把「可疑」页签和徽章摆出来（4 条：2 条可疑 / 2 条干净）
return (async () => {
  const D = window._NTRGlossaryDev;
  const old = document.getElementById('ntr-glossary-overlay');
  if (old) old.remove();
  D.GlossaryUI.open({
    title: 'AI提取术语表 - 示例（4 条）',
    entries: [
      { src: 'アリス', dst: '爱丽丝', type: '女性人名', count: 37 },
      { src: 'なるちゃん', dst: '小鸣', type: '女性人名', count: 7 },
      { src: '道化師のイラストが入っているペン', dst: '带有小丑插画的笔', type: '特殊物品', count: 1 },
      { src: '虹の橋', dst: '彩虹桥', type: '地名', count: 2 },
    ],
    existing: { '虹の橋': '彩虹桥' },
    mode: 'merge',
    onWrite: async () => ({ ok: true }),
  });
  await new Promise((r) => setTimeout(r, 250));
  return 'suspect-shot-ready';
})()

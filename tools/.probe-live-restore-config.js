// 恢复线上 origin 的提取设置为常规值（队列续跑 driver 曾经改过 分块字数/最大轮数/行数上限）
const out = {};
try {
  const header = Array.from(document.querySelectorAll('.ntr-module-header')).find((x) => x.textContent.includes('AI提取术语表'));
  const container = header.closest('.ntr-module-container');
  if (!container.querySelector('.ntr-settings-container')) {
    header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
    await new Promise((r) => setTimeout(r, 500));
  }
  const setNum = (name, v) => {
    const el = Array.from(container.querySelectorAll('input')).find((i) => {
      const label = i.closest('div') && i.closest('div').querySelector('label');
      return label && new RegExp('^' + name).test(label.textContent);
    });
    if (!el) return 'not found';
    el.value = String(v);
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return el.value;
  };
  out['分块字数'] = setNum('分块字数', 3000);
  out['最大轮数'] = setNum('最大轮数', 4);
  out['行数上限'] = setNum('行数上限', 0);
  out['输出上限'] = setNum('输出上限', 0);
  header.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2 }));
  await new Promise((r) => setTimeout(r, 200));
  const cfg = JSON.parse(localStorage.getItem('NTR_ToolBox_Config'));
  const m = cfg.modules.find((x) => x.name === 'AI提取术语表');
  out.saved = m.settings.filter((s) => ['分块字数', '最大轮数', '行数上限', '输出上限', '任务方式', '并发'].includes(s.name)).map((s) => s.name + '=' + s.value);
} catch (e) { out.err = String((e && e.stack) || e); }
return JSON.stringify(out, null, 1);

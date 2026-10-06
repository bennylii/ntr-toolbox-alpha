// daemon/job-queue.mjs —— 进程级单队列（FIFO 串行跑 runBook；控制面 /run 与 Agent 工具共用）
// 语义：同一时刻最多一个 runBook（避免并发改写共享配置/抢锁）；每项都有状态与终态快照。
export function createJobQueue({ resolveRunner, log = console, cap = 50 } = {}) {
  const items = [];
  let seq = 0;
  let pumping = false;

  const publicItem = (it) => ({
    id: it.id, bookKey: it.bookKey, job: it.job, state: it.state,
    enqueuedAt: it.enqueuedAt, startedAt: it.startedAt || 0, finishedAt: it.finishedAt || 0,
    error: it.error || '', stats: it.stats || null, options: it.options || {},
    progress: it.progress || null,
  });

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const item = items.find((q) => q.state === 'queued');
        if (!item) break;
        item.state = 'running';
        item.startedAt = Date.now();
        try {
          const runner = resolveRunner ? resolveRunner(item.job) : null;
          if (!runner) throw new Error(`${item.job} 管线未装配`);
          // progress：runner 可在执行中持续上报（publicItem 暴露给前端轮询）；不用的 runner 忽略即可
          const result = await runner.runBook(item.bookKey, { options: item.options, progress: (p) => { item.progress = p; } });
          item.state = 'done';
          item.stats = (result && result.stats) || null;
        } catch (e) {
          item.state = 'failed';
          item.error = (e && e.message) || String(e);
          log.log(`[queue] ${item.job} ${item.bookKey} 失败: ${item.error}`);
        } finally {
          item.finishedAt = Date.now();
          if (item._settle) item._settle(publicItem(item));
        }
        if (items.length > cap) items.splice(0, items.length - cap);
      }
    } finally {
      pumping = false;
    }
  }

  return {
    // 入队并返回 { item, id, done }：done 在该项到达终态时 resolve（失败也 resolve，带 error/state）
    enqueue({ bookKey, job, options = {} }) {
      const item = { id: (seq += 1), bookKey, job, options, state: 'queued', enqueuedAt: Date.now() };
      const done = new Promise((resolve) => { item._settle = resolve; });
      items.push(item);
      pump();
      return { id: item.id, item, done };
    },
    list: () => items.map(publicItem),
    get: (id) => {
      const item = items.find((q) => q.id === Number(id));
      return item ? publicItem(item) : null;
    },
    size: () => items.length,
    busy: () => pumping,
  };
}

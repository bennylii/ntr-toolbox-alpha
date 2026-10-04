// daemon/agent-events.mjs —— 会话事件总线（SSE 用）：单调 revision + 有界历史 + 订阅
export function createAgentEvents({ historyLimit = 500 } = {}) {
  const sessions = new Map();
  const bucket = (sessionId) => {
    const id = String(sessionId || '');
    if (!sessions.has(id)) sessions.set(id, { rev: 0, events: [], subs: new Set() });
    return sessions.get(id);
  };
  return {
    publish(sessionId, event) {
      const s = bucket(sessionId);
      s.rev += 1;
      const item = { rev: s.rev, at: Date.now(), ...event };
      s.events.push(item);
      if (s.events.length > historyLimit) s.events.splice(0, s.events.length - historyLimit);
      for (const cb of s.subs) {
        try { cb(item); } catch { /* 订阅者异常不影响总线 */ }
      }
      return item;
    },
    subscribe(sessionId, cb) {
      const s = bucket(sessionId);
      s.subs.add(cb);
      return () => s.subs.delete(cb);
    },
    since(sessionId, rev) {
      return bucket(sessionId).events.filter((e) => e.rev > (Number(rev) || 0));
    },
    revision: (sessionId) => bucket(sessionId).rev,
  };
}

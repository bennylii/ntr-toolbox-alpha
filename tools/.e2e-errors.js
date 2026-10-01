// 页面内验证：429 / timeout / abort / truncate / badjson / think 的错误边际处理
const E = window._NTRGlossaryDev.GlossaryEngine;
const out = {};

const mkLines = (n) => Array.from({ length: n }, (_, i) =>
  `第${i}行：アリスとローズがローズ娼館で魔導書を読む。レナリスも来た。`);

const run = async (query, extra = {}) => {
  const workers = [{ id: 'mock', model: 'mock-glossary-1', endpoint: `http://127.0.0.1:8788?${query}`, key: 'x' }];
  const requester = E.createRequester(workers, { timeoutMs: extra.timeoutMs || 4000, rps: 20, rpm: 0 });
  const lines = mkLines(extra.lines || 40);
  const events = [];
  const t0 = Date.now();
  const r = await E.runJob({
    lines,
    callLLM: (m) => requester.call(m),
    options: { budgetChars: 3000, maxRounds: extra.maxRounds || 2, concurrency: extra.concurrency || 1 },
    onProgress: (p) => events.push(p.phase),
  });
  return {
    entries: r.glossary.length,
    partials: r.glossary.filter((e) => e.partial).length,
    chunksDone: r.chunksDone,
    chunksFailed: r.chunksFailed,
    rounds: r.rounds,
    pending: r.pendingLines,
    cooldown: events.includes('cooldown'),
    ms: Date.now() - t0,
  };
};

out.ok = await run(`script=ok&run=${Date.now()}`);
out.err429thenOk = await run(`script=429,ok,ok,ok,ok,ok,ok&run=${Date.now()}`);
out.allTimeout = await run(`script=timeout,timeout&run=${Date.now()}`, { maxRounds: 1 });
out.abort = await run(`script=abort&run=${Date.now()}`, { maxRounds: 1 });
out.truncate = await run(`fail=truncate&run=${Date.now()}`, { maxRounds: 1 });
out.badjson = await run(`fail=badjson&run=${Date.now()}`, { maxRounds: 1 });
out.think = await run(`fail=think&run=${Date.now()}`, { maxRounds: 1 });
out.empty = await run(`fail=empty&run=${Date.now()}`, { maxRounds: 1 });
out.chatty = await run(`style=chatty&run=${Date.now()}`, { maxRounds: 1 });

return JSON.stringify(out, null, 2);

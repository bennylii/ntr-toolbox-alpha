// daemon/scheduler.mjs —— LLM 调度器：全局并发门（默认单线程）+ 接口池/冷却 + 限流 + 用量记账
// 规格：docs/cleanroom/spec-06-llm-scheduler.md（LinguaGacha 思路的独立实现，非逐行翻译）
// 约束：零依赖；所有 LLM 调用必须经本调度器；不静默裁剪提示词内容（超限只告警，可开严格模式）。

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const abortError = () => Object.assign(new Error('aborted'), { code: 'aborted' });

const RE_CJK = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

// 启发式 token 估算（CJK ≈ 1 token/字，其余 ≈ 0.25）；不引 tokenizer
export function estimateTokens(messages) {
  let chars = 0;
  let tokens = 0;
  for (const m of messages || []) {
    const s = String((m && m.content) || '');
    chars += s.length;
    for (const ch of s) tokens += RE_CJK.test(ch) ? 1 : 0.25;
  }
  return { chars, tokens: Math.ceil(tokens) };
}

// 业务错误（凭据/请求不合法）不计入冷却阶梯；其余（429/503/超时/网络）计入
const isBusinessError = (result) => {
  const status = Number(result && result.status) || 0;
  if ([400, 401, 402, 403, 404, 413, 422].includes(status)) return true;
  const text = String((result && result.error) || '');
  return /unauthorized|forbidden|not found|invalid.{0,16}(api.?key|token)|bad request/i.test(text);
};

const readUsage = (data) => {
  const u = data && data.usage;
  if (!u) return null;
  const promptTokens = Number(u.prompt_tokens) || 0;
  const completionTokens = Number(u.completion_tokens) || 0;
  return (promptTokens || completionTokens) ? { promptTokens, completionTokens } : null;
};

export class LlmScheduler {
  constructor({ engine, store = null, log = console, options = {} }) {
    this.engine = engine;
    this.store = store;
    this.log = log;
    this.options = {
      maxInFlight: 1,            // 全局同刻在途请求数（单线程 Gemini 场景 = 1）
      rpm: 0,                    // 每分钟派发上限；0 = 不限
      transportRetries: 3,       // 传输层重试次数（业务错误不重试）
      cooldownSteps: [15000, 30000, 60000],
      maxCooldownMs: 300000,
      minRetryWaitMs: 1000,
      timeoutMs: 300000,
      maxPromptChars: 12000,     // ≈ 16K token 内（启发式估算）
      strictPrompt: false,
      temperature: undefined,
      maxTokens: 0,
      thinking: false,
      ...options,
    };
    this.workers = [];
    this._keyState = new Map();   // id -> { step, until, failures }
    this._index = -1;
    this._permits = Math.max(1, Number(this.options.maxInFlight) || 1);
    this._waiters = [];
    this._inFlight = 0;
    this._peak = 0;
    this._rpmNext = 0;
    this._requester = null;
    this._pendingUsage = null;
    this._usage = { requests: 0, promptTokens: 0, completionTokens: 0 };
    this._stats = { requests: 0, transportRetries: 0, promptTooLong: 0, byWorker: {}, lastError: '' };
    if (Array.isArray(options.workers)) this.setWorkers(options.workers);
  }

  // ---- 接口池 ----
  setWorkers(workers) {
    const norm = (workers || []).filter((w) => w && w.endpoint).map((w, i) => ({
      id: String(w.id || `w${i}`), model: w.model || '', endpoint: w.endpoint, key: w.key || '',
    }));
    const keep = new Map();
    for (const w of norm) if (this._keyState.has(w.id)) keep.set(w.id, this._keyState.get(w.id));
    this._keyState = keep;
    for (const w of norm) if (!this._keyState.has(w.id)) this._keyState.set(w.id, { step: 0, until: 0, failures: 0 });
    this.workers = norm;
    this._requester = null;   // worker 列表变化 → 重建
    this._index = -1;
  }

  _pickWorker() {
    const n = this.workers.length;
    if (n === 0) return null;
    const now = Date.now();
    let best = null;
    for (let i = 1; i <= n; i += 1) {
      const idx = (this._index + i) % n;
      const w = this.workers[idx];
      const st = this._keyState.get(w.id) || { until: 0 };
      if (now >= st.until) { this._index = idx; return { worker: w, waitMs: 0 }; }
      const waitMs = st.until - now;
      if (!best || waitMs < best.waitMs) best = { worker: w, waitMs };
    }
    return best;
  }

  _markCooling(worker, retryAfterMs) {
    const st = this._keyState.get(worker.id) || { step: 0, until: 0, failures: 0 };
    const steps = this.options.cooldownSteps;
    const base = steps[Math.min(st.step, steps.length - 1)];
    const upstream = Math.min(this.options.maxCooldownMs, Number(retryAfterMs) || 0);
    this._keyState.set(worker.id, {
      step: st.step + 1,
      until: Date.now() + Math.max(base, upstream),
      failures: st.failures + 1,
    });
  }

  _markOk(worker) {
    const st = this._keyState.get(worker.id);
    if (st) this._keyState.set(worker.id, { step: 0, until: 0, failures: 0 });
  }

  // ---- 全局并发门（FIFO） ----
  async _acquire(signal) {
    if (this._waiters.length === 0 && this._permits > 0) {
      this._permits -= 1;
      this._inFlight += 1;
      this._peak = Math.max(this._peak, this._inFlight);
      return;
    }
    await new Promise((resolve, reject) => {
      const waiter = { resolve, reject };
      this._waiters.push(waiter);
      if (signal) {
        const onAbort = () => {
          const i = this._waiters.indexOf(waiter);
          if (i >= 0) this._waiters.splice(i, 1);
          reject(abortError());
        };
        if (signal.aborted) { onAbort(); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    this._inFlight += 1;
    this._peak = Math.max(this._peak, this._inFlight);
  }

  _release() {
    this._inFlight = Math.max(0, this._inFlight - 1);
    const next = this._waiters.shift();
    if (next) next.resolve();
    else this._permits += 1;
  }

  _sleep(ms, signal) {
    if (!ms) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); if (signal) signal.removeEventListener('abort', onAbort); };
      const onAbort = () => { cleanup(); reject(abortError()); };
      const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
      if (signal) {
        if (signal.aborted) { cleanup(); reject(abortError()); return; }
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
  }

  async _rpmWait(signal) {
    const rpm = Number(this.options.rpm) || 0;
    if (rpm <= 0) return;
    const interval = 60000 / rpm;
    const now = Date.now();
    const slot = Math.max(now, this._rpmNext);
    this._rpmNext = slot + interval;   // 单线程内原子占位
    if (slot > now) await this._sleep(slot - now, signal);
  }

  // ---- 请求执行 ----
  _ensureRequester() {
    if (this._requester) return this._requester;
    this._requester = this.engine.createRequester(this.workers, {
      timeoutMs: this.options.timeoutMs,
      temperature: this.options.temperature,
      maxTokens: this.options.maxTokens,
      thinking: this.options.thinking,
      fetchImpl: this._fetch,
    });
    return this._requester;
  }

  // 包装 fetch：读一份响应副本取 usage（不影响引擎读取原响应）
  _fetch = async (url, init) => {
    const res = await fetch(url, init);
    this._pendingUsage = null;
    if (res.ok) {
      try { this._pendingUsage = readUsage(await res.clone().json()); } catch { /* 非 JSON 忽略 */ }
    }
    return res;
  };

  async _callOnce(worker, messages, signal) {
    const requester = this._ensureRequester();
    const promise = requester.call(messages, { worker });
    if (!signal) return promise;
    if (signal.aborted) throw abortError();
    return Promise.race([
      promise,
      new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortError()), { once: true })),
    ]);
  }

  _account(messages, result, usage) {
    this._usage.requests += 1;
    if (usage) {
      this._usage.promptTokens += usage.promptTokens;
      this._usage.completionTokens += usage.completionTokens;
      return;
    }
    this._usage.promptTokens += estimateTokens(messages).tokens;
    if (result && result.ok) {
      this._usage.completionTokens += estimateTokens([{ content: result.content || '' }]).tokens;
    }
  }

  // call(messages, { signal }) → 与 engine.createRequester 的回调同形
  async call(messages, { signal } = {}) {
    const size = estimateTokens(messages);
    if (size.chars > this.options.maxPromptChars) {
      this._stats.promptTooLong += 1;
      this.log.log(`[llm] 提示词偏大：${size.chars} 字符（≈${size.tokens} token，阈值 ${this.options.maxPromptChars}）`);
      if (this.options.strictPrompt) return { ok: false, error: `prompt-too-long：${size.chars} 字符（阈值 ${this.options.maxPromptChars}）` };
    }
    if (this.workers.length === 0) return { ok: false, error: '没有可用的翻译器' };

    let attempts = 0;
    for (;;) {
      if (signal && signal.aborted) return { ok: false, error: 'aborted' };
      const picked = this._pickWorker();
      if (!picked) return { ok: false, error: '没有可用的翻译器' };
      try {
        if (picked.waitMs > 0) await this._sleep(Math.min(this.options.maxCooldownMs, picked.waitMs), signal);
        await this._rpmWait(signal);
      } catch (e) { return { ok: false, error: 'aborted' }; }

      await this._acquire(signal);
      let result;
      this._pendingUsage = null;
      try {
        result = await this._callOnce(picked.worker, messages, signal);
      } catch (e) {
        result = { ok: false, error: (e && e.message) || String(e), retryAfterMs: 0, workerId: picked.worker.id };
      } finally {
        this._release();
      }
      const usage = this._pendingUsage;
      this._stats.requests += 1;
      const st = this._stats.byWorker[picked.worker.id] || (this._stats.byWorker[picked.worker.id] = { requests: 0, failures: 0 });
      st.requests += 1;

      if (result.ok) {
        this._markOk(picked.worker);
        this._account(messages, result, usage);
        return result;
      }
      st.failures += 1;
      this._stats.lastError = result.error || '';
      const business = isBusinessError(result);
      if (!business) this._markCooling(picked.worker, result.retryAfterMs);
      attempts += 1;
      if (business || attempts > this.options.transportRetries || (signal && signal.aborted)) {
        this._account(messages, result, usage);
        return result;
      }
      const waitMs = Math.min(this.options.maxCooldownMs, Math.max(this.options.minRetryWaitMs, Number(result.retryAfterMs) || 0));
      this._stats.transportRetries += 1;
      this.log.log(`[llm] 传输失败（${result.error || '?'}），${Math.round(waitMs / 1000)}s 后重试 ${attempts}/${this.options.transportRetries}`);
      try { await this._sleep(waitMs, signal); } catch (e) { return { ok: false, error: 'aborted' }; }
    }
  }

  // 取出并清零待落库用量（管线在每轮 run 结束时调用）
  takeUsage() {
    const u = this._usage;
    this._usage = { requests: 0, promptTokens: 0, completionTokens: 0 };
    return u;
  }

  stats() {
    const byWorker = {};
    const now = Date.now();
    for (const w of this.workers) {
      const st = this._stats.byWorker[w.id] || { requests: 0, failures: 0 };
      const ks = this._keyState.get(w.id) || { step: 0, until: 0 };
      byWorker[w.id] = { ...st, step: ks.step || 0, coolingMs: Math.max(0, (ks.until || 0) - now) };
    }
    return {
      workers: this.workers.length,
      maxInFlight: this.options.maxInFlight,
      requests: this._stats.requests,
      transportRetries: this._stats.transportRetries,
      promptTooLong: this._stats.promptTooLong,
      inFlightNow: this._inFlight,
      maxObservedInFlight: this._peak,
      byWorker,
      lastError: this._stats.lastError,
    };
  }
}

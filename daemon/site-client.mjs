// daemon/site-client.mjs —— 站点契约客户端（工作区兼容；与站点前端同一套接口）
// kind: 'web'（/api/novel/...）| 'wenku'（/api/wenku/...）；401 有明确错误码（提示重新同步凭据）。
// 传输层重试：站点常经代理访问（链路抖动 → ECONNRESET / fetch failed / 超时），失败按次数退避重试；
// HTTP 状态错误（401/400/404/5xx 响应）不重试，直接抛给上层。
export class SiteClient {
  constructor({ origin, token, engine, fetchImpl, retries = 3, retryDelayMs = 300, onRetry = null }) {
    this.engine = engine;   // parseParallelText 等纯函数（术语管线用）
    this.origin = String(origin || '').replace(/\/$/, '');
    this.token = token || '';
    // 出网收口：默认全局 fetch；daemon 装配时注入代理转发（daemon/proxy.mjs）
    this.fetchImpl = typeof fetchImpl === 'function' ? fetchImpl : ((...args) => globalThis.fetch(...args));
    const n = Number(retries);
    this.retries = Number.isFinite(n) ? Math.max(0, Math.min(6, Math.floor(n))) : 3;
    const d = Number(retryDelayMs);
    this.retryDelayMs = Number.isFinite(d) && d >= 0 ? d : 300;
    this.onRetry = typeof onRetry === 'function' ? onRetry : null;
  }

  setToken(token) { this.token = token || ''; }

  // 传输失败重试（退避 retryDelayMs × 次数）；HTTP 状态错误在读取层标 noRetry 后不重试
  async #withRetries(label, run) {
    let lastErr = null;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      try { return await run(); } catch (e) {
        if (e && e.noRetry) throw e;
        lastErr = e;
        if (attempt >= this.retries) break;
        if (this.onRetry) { try { this.onRetry(e, attempt + 1, label); } catch { } }
        await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs * (attempt + 1)));
      }
    }
    throw lastErr;
  }

  // 传输/状态错误分流：状态码错误不回重试
  static #httpError(message, code = '') {
    const e = new Error(message);
    if (code) e.code = code;
    e.noRetry = true;
    return e;
  }

  async fetchRaw(pathname, { method = 'GET', body, timeoutMs = 60000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await this.fetchImpl(this.origin + pathname, {
        method,
        headers: {
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }

  // 401 在上游承载三种含义（Authentication.kt）：token 非法/过期、账号封禁、权限不足
  // （术语表写入要求 member 且注册满 30 天）。token 问题带 WWW-Authenticate: Bearer error="invalid_token"
  // （缺 Authorization 头时是裸 `Bearer`）——凡是 Bearer 挑战都算凭据问题；封禁/权限不足是裸 401，
  // 按「权限问题」报，否则会把用户引去反复重同步凭据，而真正的原因是权限。
  static async #unauthorizedError(res) {
    const challenge = String((res.headers && res.headers.get && res.headers.get('www-authenticate')) || '');
    let body = '';
    try { body = await res.text(); } catch { }
    if (/^\s*Bearer/i.test(challenge) || /Token不合法或者过期/.test(body)) {
      return SiteClient.#httpError('401 未授权：站点凭据失效，请重新同步凭据', 'unauthorized');
    }
    return SiteClient.#httpError(`401 无权限：账号被限制或权限不足${body ? `（${String(body).slice(0, 80)}）` : ''}——术语表写入需 member 且注册满 30 天`, 'forbidden');
  }

  async #json(pathname, options) {
    return this.#withRetries(pathname, async () => {
      const res = await this.fetchRaw(pathname, options);
      if (res.status === 401) throw await SiteClient.#unauthorizedError(res);
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw SiteClient.#httpError(`HTTP ${res.status} ${pathname}${detail ? `：${String(detail).slice(0, 120)}` : ''}`);
      }
      return res.json();
    });
  }

  async getText(pathname) {
    return this.#withRetries(pathname, async () => {
      const res = await this.fetchRaw(pathname);
      if (res.status === 401) throw await SiteClient.#unauthorizedError(res);
      if (!res.ok) throw SiteClient.#httpError(`HTTP ${res.status} ${pathname}`);
      return res.text();
    });
  }

  async putGlossaryRaw(book, glossary) {
    const pathname = book.kind === 'web'
      ? `/api/novel/${book.providerId}/${book.novelId}/glossary`
      : `/api/wenku/${book.novelId}/glossary`;
    // 整表替换。注意上游对「内容没变」是主动返 400（web「修改为空」/文库「术语表没有改变」），
    // 那不是失败：内容一致本来就等价于写成功，且「服务端已写入但响应丢失」的重试也会走到这里。
    // 语义出处见 docs/upstream-sync.md ⑦
    return this.#withRetries(pathname, async () => {
      const res = await this.fetchRaw(pathname, { method: 'PUT', body: glossary });
      if (res.status === 401) throw await SiteClient.#unauthorizedError(res);
      if (res.status === 400) {
        const detail = (await res.text().catch(() => '')).trim();
        // 全等匹配（上游只有这两句）：将来别处复用同词也不会被误判成「内容一致」
        if (detail === '修改为空' || detail === '术语表没有改变') return true;   // 内容一致 = 已是目标状态
        throw SiteClient.#httpError(`写入术语表失败 HTTP 400${detail ? `：${detail.slice(0, 120)}` : ''}`);
      }
      if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw SiteClient.#httpError(`写入术语表失败 HTTP ${res.status}${detail ? `：${String(detail).slice(0, 120)}` : ''}`);
      }
      return true;
    });
  }

  // ---- 契约方法（翻译 worker 所需） ----
  async getNovel(providerId, novelId) { return this.#json(`/api/novel/${providerId}/${novelId}`); }
  async getWenku(novelId) { return this.#json(`/api/wenku/${novelId}`); }
  async getGlossary(book) {
    const meta = book.kind === 'web'
      ? await this.getNovel(book.providerId, book.novelId)
      : await this.getWenku(book.novelId);
    return meta.glossary || {};
  }

  // 翻译任务：web 一次拿全书 toc；wenku 逐卷拿（返回 [{ volumeId, toc }]）
  async getTranslateTasks(book, translatorId) {
    if (book.kind === 'web') {
      const task = await this.#json(`/api/novel/${book.providerId}/${book.novelId}/translate-v2/${translatorId}`);
      return [{ volumeId: '', toc: task.toc || [], glossaryUuid: task.glossaryUuid || '', glossary: task.glossary || {} }];
    }
    const novel = await this.getWenku(book.novelId);
    const volumes = novel.volumeJp || [];
    if (volumes.length === 0) throw new Error('该文库小说没有已上传的日文卷');
    const out = [];
    for (const volume of volumes) {
      const task = await this.#json(`/api/wenku/${book.novelId}/translate-v2/${translatorId}/${encodeURIComponent(volume.volumeId)}`);
      // 文库的字段名是 glossaryId（书级一个、逐章一个），语义与 web 的 glossaryUuid 相同：
      // 逐章缺失（上游 explicitNulls=false，未译章省略该键）= 从未用当前术语表翻过。
      // 照搬 web 形状会让 planTargets 把「未译」当成「已翻过」→ normal/expire 档在文库上失灵。
      const toc = (task.toc || []).map((item) => (
        item.glossaryUuid !== undefined || item.glossaryId === undefined
          ? item
          : { ...item, glossaryUuid: item.glossaryId }
      ));
      out.push({ volumeId: volume.volumeId, toc, glossaryUuid: task.glossaryId || '', glossary: {} });
    }
    return out;
  }

  // /file 必须带 filename（站点 controller 无默认值，缺了 404）；剔除书名里的路径不安全字符
  #fileQuery(prefix, book, params) {
    const safe = String(book.novelId || 'book').replace(/[/|\\:*?"<>]/g, '');
    const query = new URLSearchParams({ mode: params.mode, translationsMode: params.translationsMode, type: 'txt', filename: `${prefix}.${safe}.txt` });
    if (params.translations) query.append('translations', params.translations);
    return query.toString();
  }

  // 整本原文（web：/file?mode=jp；wenku：逐卷逐章 paragraphJp）
  async getBookText(book, onProgress) {
    if (book.kind === 'web') {
      const q = this.#fileQuery('jp', book, { mode: 'jp', translationsMode: 'parallel' });
      return this.getText(`/api/novel/${book.providerId}/${book.novelId}/file?${q}`);
    }
    const novel = await this.getWenku(book.novelId);
    const volumes = novel.volumeJp || [];
    if (volumes.length === 0) throw new Error('该文库小说没有已上传的日文卷');
    const parts = [];
    for (let vi = 0; vi < volumes.length; vi += 1) {
      const volumeId = volumes[vi].volumeId;
      if (onProgress) onProgress(`抓取正文：卷 ${vi + 1}/${volumes.length}`);
      const task = await this.#json(`/api/wenku/${book.novelId}/translate-v2/gpt/${encodeURIComponent(volumeId)}`);
      const toc = task.toc || [];
      for (const item of toc) {
        const dto = await this.#json(`/api/wenku/${book.novelId}/translate-v2/gpt/${encodeURIComponent(volumeId)}/chapter-task/${item.chapterId}`);
        parts.push((dto.paragraphJp || []).join('\n'));
      }
    }
    return parts.join('\n\n');
  }

  // 对齐对（验收回扫用）：web 走 /file?mode=jp-zh + 引擎解析；wenku 走 chapter-task 段落数组
  async getAlignedPairs(book, onProgress) {
    if (book.kind === 'web') {
      const q = this.#fileQuery('jpzh', book, { mode: 'jp-zh', translationsMode: 'priority', translations: 'gpt' });
      const text = await this.getText(`/api/novel/${book.providerId}/${book.novelId}/file?${q}`);
      const parsed = this.engine.parseParallelText(text);
      const novel = await this.getNovel(book.providerId, book.novelId);
      const tocMap = new Map((novel.toc || []).filter((t) => t.chapterId).map((t) => [t.titleJp, t.chapterId]));
      parsed.pairs.forEach((pair) => { pair.chapterId = tocMap.get(pair.chapter); });
      return parsed;
    }
    const novel = await this.getWenku(book.novelId);
    const volumes = novel.volumeJp || [];
    const pairs = [];
    let chapters = 0;
    let translationMissing = 0;
    for (const volume of volumes) {
      const task = await this.#json(`/api/wenku/${book.novelId}/translate-v2/gpt/${encodeURIComponent(volume.volumeId)}`);
      const toc = task.toc || [];
      for (const item of toc) {
        const dto = await this.#json(`/api/wenku/${book.novelId}/translate-v2/gpt/${encodeURIComponent(volume.volumeId)}/chapter-task/${item.chapterId}`);
        chapters += 1;
        const jp = dto.paragraphJp || [];
        const zh = Array.isArray(dto.oldParagraphZh) ? dto.oldParagraphZh : [];
        if (jp.length > 0 && zh.length === 0) translationMissing += 1;
        jp.forEach((paragraph, i) => {
          const translated = typeof zh[i] === 'string' ? zh[i] : '';
          if (paragraph && translated) pairs.push({ jp: paragraph, zh: translated, chapter: item.title || '', chapterId: item.chapterId, volumeId: volume.volumeId });
        });
      }
    }
    return { pairs, chapters, translationMissing, chapterMissing: 0, dropped: 0 };
  }

  // 整本译文（回读校验/验收回扫的 zh 侧；web 用 mode=zh 整本导出，wenku 用 chapter-task 的 oldParagraphZh）
  // 返回：web → string（整本 txt）；wenku → { text, translated }
  async getBookZhText(book, onProgress, { translator = 'gpt' } = {}) {
    if (book.kind === 'web') {
      const q = this.#fileQuery('zh', book, { mode: 'zh', translationsMode: 'priority', translations: translator });
      return this.getText(`/api/novel/${book.providerId}/${book.novelId}/file?${q}`);
    }
    const novel = await this.getWenku(book.novelId);
    const volumes = novel.volumeJp || [];
    const lines = [];
    let translated = 0;
    for (const volume of volumes) {
      const task = await this.#json(`/api/wenku/${book.novelId}/translate-v2/${translator}/${encodeURIComponent(volume.volumeId)}`);
      const toc = task.toc || [];
      for (const item of toc) {
        const dto = await this.#json(`/api/wenku/${book.novelId}/translate-v2/${translator}/${encodeURIComponent(volume.volumeId)}/chapter-task/${item.chapterId}`);
        const jp = dto.paragraphJp || [];
        const zh = Array.isArray(dto.oldParagraphZh) ? dto.oldParagraphZh : [];
        jp.forEach((p, i) => {
          const t = typeof zh[i] === 'string' ? zh[i] : '';
          if (t !== '') translated += 1;
          lines.push(t);
        });
      }
    }
    return { text: lines.join('\n'), translated };
  }

  // 章节任务（web 为 POST、文库为 GET，与站点前端一致）；web 路由的 sync 参数必填（缺了 404），
  // sync=true 仅站点「同步原文」档用，翻译链路一律 false
  async getChapterTask(book, chapterId, translatorId, volumeId = '') {
    return book.kind === 'web'
      ? this.#json(`/api/novel/${book.providerId}/${book.novelId}/translate-v2/${translatorId}/chapter-task/${chapterId}?sync=false`, { method: 'POST', body: {} })
      : this.#json(`/api/wenku/${book.novelId}/translate-v2/${translatorId}/${encodeURIComponent(volumeId)}/chapter-task/${chapterId}`);
  }

  // 上传章节译文（带当前 glossaryId；段落数必须与章节一致，否则站点 400）
  async uploadChapter(book, chapterId, { glossaryId, paragraphsZh }, translatorId, volumeId = '') {
    const body = { glossaryId, paragraphsZh, sakuraVersion: '0.9' };
    return book.kind === 'web'
      ? this.#json(`/api/novel/${book.providerId}/${book.novelId}/translate-v2/${translatorId}/chapter/${chapterId}`, { method: 'POST', body })
      : this.#json(`/api/wenku/${book.novelId}/translate-v2/${translatorId}/${encodeURIComponent(volumeId)}/chapter/${chapterId}`, { method: 'POST', body });
  }
}

// daemon/site-client.mjs —— 站点契约客户端（工作区兼容；与站点前端同一套接口）
// kind: 'web'（/api/novel/...）| 'wenku'（/api/wenku/...）；401 有明确错误码（提示重新同步凭据）。
export class SiteClient {
  constructor({ origin, token, engine }) {
    this.engine = engine;   // parseParallelText 等纯函数（术语管线用）
    this.origin = String(origin || '').replace(/\/$/, '');
    this.token = token || '';
  }

  setToken(token) { this.token = token || ''; }

  async fetchRaw(pathname, { method = 'GET', body, timeoutMs = 60000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(this.origin + pathname, {
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

  async #json(pathname, options) {
    const res = await this.fetchRaw(pathname, options);
    if (res.status === 401) { const e = new Error('401 未授权：token 失效，请重新同步凭据'); e.code = 'unauthorized'; throw e; }
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${pathname}${detail ? `：${String(detail).slice(0, 120)}` : ''}`);
    }
    return res.json();
  }

  async getText(pathname) {
    const res = await this.fetchRaw(pathname);
    if (res.status === 401) { const e = new Error('401 未授权：token 失效，请重新同步凭据'); e.code = 'unauthorized'; throw e; }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${pathname}`);
    return res.text();
  }

  async putGlossaryRaw(book, glossary) {
    const pathname = book.kind === 'web'
      ? `/api/novel/${book.providerId}/${book.novelId}/glossary`
      : `/api/wenku/${book.novelId}/glossary`;
    const res = await this.fetchRaw(pathname, { method: 'PUT', body: glossary });
    if (res.status === 401) { const e = new Error('401 未授权：token 失效，请重新同步凭据'); e.code = 'unauthorized'; throw e; }
    if (!res.ok) { const detail = await res.text().catch(() => ''); throw new Error(`写入术语表失败 HTTP ${res.status}${detail ? `：${String(detail).slice(0, 120)}` : ''}`); }
    return true;
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
      out.push({ volumeId: volume.volumeId, toc: task.toc || [], glossaryUuid: task.glossaryUuid || '', glossary: task.glossary || {} });
    }
    return out;
  }

  // 整本原文（web：/file?mode=jp；wenku：逐卷逐章 paragraphJp）
  async getBookText(book, onProgress) {
    if (book.kind === 'web') {
      return this.getText(`/api/novel/${book.providerId}/${book.novelId}/file?mode=jp&translationsMode=parallel&type=txt`);
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
      const text = await this.getText(`/api/novel/${book.providerId}/${book.novelId}/file?mode=jp-zh&translationsMode=priority&translations=gpt&type=txt`);
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

  // 整本译文（验收回扫的 zh 侧；web 用 mode=zh，wenku 用 chapter-task 的 oldParagraphZh）
  async getBookZhText(book, onProgress) {
    if (book.kind === 'web') {
      return this.getText(`/api/novel/${book.providerId}/${book.novelId}/file?mode=zh&translationsMode=priority&translations=gpt&type=txt`);
    }
    const novel = await this.getWenku(book.novelId);
    const volumes = novel.volumeJp || [];
    const lines = [];
    let translated = 0;
    for (const volume of volumes) {
      const task = await this.#json(`/api/wenku/${book.novelId}/translate-v2/gpt/${encodeURIComponent(volume.volumeId)}`);
      const toc = task.toc || [];
      for (const item of toc) {
        const dto = await this.#json(`/api/wenku/${book.novelId}/translate-v2/gpt/${encodeURIComponent(volume.volumeId)}/chapter-task/${item.chapterId}`);
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

  // 章节任务（web 为 POST、文库为 GET，与站点前端一致）
  async getChapterTask(book, chapterId, translatorId, volumeId = '') {
    return book.kind === 'web'
      ? this.#json(`/api/novel/${book.providerId}/${book.novelId}/translate-v2/${translatorId}/chapter-task/${chapterId}`, { method: 'POST', body: {} })
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

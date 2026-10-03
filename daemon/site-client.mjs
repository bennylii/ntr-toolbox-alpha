// daemon/site-client.mjs —— 站点契约客户端（工作区兼容；与站点前端同一套接口）
// kind: 'web'（/api/novel/...）| 'wenku'（/api/wenku/...）；401 有明确错误码（提示重新同步凭据）。
export class SiteClient {
  constructor({ origin, token }) {
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

  // ---- 契约方法（翻译 worker 所需） ----
  async getNovel(providerId, novelId) { return this.#json(`/api/novel/${providerId}/${novelId}`); }
  async getWenku(novelId) { return this.#json(`/api/wenku/${novelId}`); }

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

// ==UserScript==
// @name         NTR Toolbox Alpha
// @namespace    https://github.com/bennylii
// @version      v0.8.0-alpha.2
// @author       bennylii
// @description  ToolBox for novel translation sites, with an AI glossary pipeline (alpha)
// @match        https://books.fishhawk.top/*
// @match        https://books1.fishhawk.top/*
// @match        https://n.novelia.cc/*
// @grant        GM_openInTab
// @license      MIT
// ==/UserScript==

(function () {
    'use strict';

    if (window._NTRToolBoxInstance) {
        return;
    }

    window._NTRToolBoxInstance = true;

    const CONFIG_VERSION = 23;
    const VERSION = 'v0.8.0-alpha.1';
    const CONFIG_STORAGE_KEY = 'NTR_ToolBox_Config';
    const IS_MOBILE = /Mobi|Android/i.test(navigator.userAgent);
    const domainAllowed = (location.hostname === 'books.fishhawk.top' || location.hostname === 'books1.fishhawk.top' || location.hostname === 'n.novelia.cc');

    // -----------------------------------
    // Module settings（clean-room 重写，契约：docs/cleanroom/spec-02-helper-layer.md §1）
    // -----------------------------------

    // 设置项的形状刻意保持扁平（name/type/value [+options]）：它们会被整体序列化进 NTR_ToolBox_Config，
    // spec-01 的合并逻辑按 name 对号、只取 value —— 改形状等于改存储契约
    function newBooleanSetting(name, boolDefault) {
        return { name, type: 'boolean', value: Boolean(boolDefault) };
    }
    function newNumberSetting(name, numDefault) {
        return { name, type: 'number', value: Number(numDefault || 0) };
    }
    function newStringSetting(name, strDefault) {
        return { name, type: 'string', value: String(strDefault == null ? '' : strDefault) };
    }
    function newSelectSetting(name, options, valDefault) {
        return { name, type: 'select', value: valDefault, options };
    }
    function newTextareaSetting(name, strDefault) {
        return { name, type: 'textarea', value: String(strDefault == null ? '' : strDefault) };
    }
    function getModuleSetting(mod, key) {
        const setting = mod && mod.settings && mod.settings.find((s) => s.name === key);
        return setting ? setting.value : undefined;
    }

    // 站点工作区里配置的 GPT 翻译器：老工作区存 workspace-gpt，
    // 新版「GPT工作区BETA」(/workspace/gpt-pipeline) 另存一份 workspace-gpt-pipeline —— 两处都要读，否则新工作区里加的翻译器在设置里看不到
    const WORKSPACE_GPT_KEYS = ['workspace-gpt-pipeline', 'workspace-gpt'];
    const readWorkspaceGptWorkers = () => {
        const seen = new Set();
        const out = [];
        for (const key of WORKSPACE_GPT_KEYS) {
            let workers = [];
            try {
                const raw = localStorage.getItem(key);
                workers = raw ? ((JSON.parse(raw) || {}).workers || []) : [];
            } catch (e) { workers = []; }
            for (const w of workers) {
                if (!w || !w.id || !w.endpoint) continue;
                const sig = `${w.id}|${w.endpoint}|${w.model || ''}`;
                if (seen.has(sig)) continue;
                seen.add(sig);
                out.push(w);
            }
        }
        return out;
    };
    // 「翻译器」选择框的选项（id 就是添加时填的名字）
    // '' = 全部（按顺序轮换）；函数形式是为了每次渲染/打开设置时重新读取（工作区里新增的翻译器不用刷新页面）
    const workspaceTranslatorOptions = () => {
        const options = [{ value: '', label: '全部（自动轮换）' }];
        readWorkspaceGptWorkers().forEach((w) => {
            options.push({ value: String(w.id), label: w.model ? `${w.id}（${w.model}）` : String(w.id) });
        });
        return options;
    };
    // 需要「术语表目标」的模块只在能确定目标的页面显示：网页小说详情 / 文库详情 / 本地书架
    // （列表页、工作区这类页面点了也无法确定改哪本书的术语表，干脆不显示；术语队列管理的是已存任务，不受此限）
    const hasGlossaryTargetPage = () => [
        /^\/novel\/[^/]+\/[^/]+/,   // /novel/{provider}/{novelId}
        /^\/wenku\/[^/]+/,          // /wenku/{novelId}
        /^\/favorite\/local/,       // 本地书架（运行时再从卷列表里选）
    ].some((re) => re.test(location.pathname));

    // 模块在当前页是否可用（clean-room 重写，契约：docs/cleanroom/spec-02-helper-layer.md §2）：
    // needsTarget 的模块还要落在「能确定术语表目标」的页面上才有意义
    function isModuleEnabledByWhitelist(modItem) {
        if (modItem.needsTarget && !hasGlossaryTargetPage()) {
            return false;
        }
        if (!modItem.whitelist) {
            return domainAllowed;
        }
        const routes = Array.isArray(modItem.whitelist) ? modItem.whitelist : [modItem.whitelist];
        const onAllowedRoute = routes.some((route) => {
            if (typeof route !== 'string') return false;
            if (route.endsWith('/*')) {
                const base = route.slice(0, -2);
                return location.pathname === base || location.pathname.startsWith(base);
            }
            return location.pathname.includes(route);
        });
        return domainAllowed && onAllowedRoute;
    }

    // -----------------------------------
    // Module definitions
    // -----------------------------------
    const moduleAddSakuraTranslator = {
        name: '添加Sakura翻译器',
        type: 'onclick',
        whitelist: '/workspace/sakura',
        settings: [
            newNumberSetting('数量', 5),
            newStringSetting('名称', 'NTR translator '),
            newStringSetting('链接', 'https://sakura-share.one'),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            // 批量注册到站点工作区：数量>1 时按 名称+序号 命名（同 id 覆盖、新 id 追加，由 StorageUtils 负责）
            StorageUtils.addSakuraWorker(
                getModuleSetting(cfg, '名称') || '',
                getModuleSetting(cfg, '链接') || '',
                getModuleSetting(cfg, '数量') || 1,
            );
        },
    };

    const moduleAddGPTTranslator = {
        name: '添加GPT翻译器',
        type: 'onclick',
        whitelist: '/workspace/gpt',
        settings: [
            newNumberSetting('数量', 5),
            newStringSetting('名称', 'NTR translator '),
            newStringSetting('模型', 'deepseek-chat'),
            newStringSetting('链接', 'https://api.deepseek.com'),
            newStringSetting('Key', 'sk-wait-for-input'),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            StorageUtils.addGPTWorker(
                getModuleSetting(cfg, '名称') || '',
                getModuleSetting(cfg, '模型') || '',
                getModuleSetting(cfg, '链接') || '',
                getModuleSetting(cfg, 'Key') || '',
                getModuleSetting(cfg, '数量') || 1,
            );
        },
    };

    const moduleDeleteTranslator = {
        name: '删除翻译器',
        type: 'onclick',
        whitelist: '/workspace',
        settings: [
            newBooleanSetting('确认删除', true),
            newStringSetting('排除', '共享,本机,AutoDL'),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            // 工作区键按页面 URL 收尾判定；两者都不是就无事可做
            const key = location.href.endsWith('gpt') ? StorageUtils.gpt
                : (location.href.endsWith('sakura') ? StorageUtils.sakura : null);
            if (!key) return;

            const excludeList = (getModuleSetting(cfg, '排除') || '').split(',').filter(Boolean);
            const data = await StorageUtils._getData(key);
            const deletable = data.workers.filter((w) => !excludeList.includes(w.id));

            if (getModuleSetting(cfg, '确认删除') && deletable.length > 0) {
                if (!confirm(`确定要删除 ${deletable.length} 个翻译器吗？`)) {
                    NotificationUtils.showWarning('已取消删除');
                    return;
                }
            }
            await StorageUtils.removeAllWorkers(key, excludeList);
            NotificationUtils.showSuccess(key === StorageUtils.gpt ? '已删除 GPT 翻译器' : '已删除 Sakura 翻译器');
        },
    };

    const moduleLaunchTranslator = {
        name: '启动翻译器',
        type: 'onclick',
        whitelist: '/workspace',
        settings: [
            newNumberSetting('延迟间隔', 50),
            newNumberSetting('最多启动', 999),
            newBooleanSetting('避免无效启动', true),
            newStringSetting('排除', '本机,AutoDL'),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg, auto) {
            const intervalVal = getModuleSetting(cfg, '延迟间隔') || 50;
            const maxClick = getModuleSetting(cfg, '最多启动') || 999;
            const noEmptyLaunch = getModuleSetting(cfg, '避免无效启动');
            // 「排除」是历史遗留设置：站点按钮上取不到 worker 名，实际从未参与过滤

            const targets = [...document.querySelectorAll('button')].filter((btn) => {
                if (!auto && noEmptyLaunch) return true;
                const listItem = btn.closest('.n-list-item');
                if (listItem) {
                    // 自动模式跳过已报网络错误的条目
                    return ![...listItem.querySelectorAll('div')]
                        .some((div) => div.textContent.includes('TypeError: Failed to fetch'));
                }
                return true;
            });

            let idx = 0, clickCount = 0, lastRunning = 0, emptyCheck = 0;
            const wait = (ms) => new Promise((r) => setTimeout(r, ms));
            while (idx < targets.length && clickCount < maxClick) {
                const btn = targets[idx++];
                if (btn.textContent.includes('启动')) {
                    btn.click();
                    clickCount++;
                    await wait(intervalVal);
                }
                if (noEmptyLaunch) {
                    // 上游 quirk：lastRunning 从不更新 → 每轮都 emptyCheck++，即最多走 4 轮就提前停
                    const running = [...document.querySelectorAll('button')].filter((b) => b.textContent.includes('停止')).length;
                    if (running === lastRunning) emptyCheck++;
                    if (emptyCheck > 3) break;
                }
            }
        },
    };

    const moduleQueueSakuraV2 = {
        name: '排队Sakura v2',
        type: 'onclick',
        whitelist: ['/wenku', '/novel', '/favorite'],
        progress: { percentage: 0, info: '' },
        settings: [
            newNumberSetting('单次撷取web数量(可破限)', 20),
            newNumberSetting('撷取单页wenku数量(deving)', 20),
            newSelectSetting('模式', ['常规', '过期', '重翻'], '常规'),
            newSelectSetting('分段', ['智能', '固定'], '智能'),
            newNumberSetting('智能均分任务上限', 1000),
            newNumberSetting('智能均分章节下限', 5),
            newNumberSetting('固定均分任务', 6),
            newBooleanSetting('R18(需登入)', true),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            const webLimit = getModuleSetting(cfg, '单次撷取web数量(可破限)') || 20;
            const pair = getModuleSetting(cfg, '固定均分任务') || 6;
            const smartJobLimit = getModuleSetting(cfg, '智能均分任务上限') || 1000;
            const smartChapterLimit = getModuleSetting(cfg, '智能均分章节下限') || 5;
            const pageType = TaskUtils.getTypeString(window.location.pathname);
            const mode = getModuleSetting(cfg, '模式') || '常规';
            const sepMode = getModuleSetting(cfg, '分段') || '智能';
            const r18Bypass = getModuleSetting(cfg, 'R18(需登入)');
            const level = SettingUtils.getTranslateMode(mode);
            const storeKey = StorageUtils.sakura;

            // 文库详情页借用站点自己的排队按钮：先按模式点一遍，再点「排队Sakura」
            const clickSiteQueueButtons = async () => {
                await TaskUtils.clickButtons(mode);
                await TaskUtils.clickButtons('排队Sakura');
            };
            const split = (novels) => (sepMode === '智能')
                ? TaskUtils.assignTasksSmart(novels, smartJobLimit, smartChapterLimit, level)
                : TaskUtils.assignTasksStatic(novels, pair, level);
            const toJobs = (novels) => novels.map((item) => ({
                url: `/${item.providerId}/${item.novelId}`,
                description: item.titleZh ?? item.titleJp,
                total: item.total,
                sakura: item.sakura,
            }));

            // 卷目录：失败重试 3 次（间隔 1s）；错误文案尾缀按分支沿用上游原文（wenkus 句号 / favorite 冒号）
            const wenkuVolumes = async (novelId, tail = '.') => {
                for (let attempts = 0; attempts < 3; attempts++) {
                    try {
                        const res = await script.fetch(`${window.location.origin}/api/wenku/${novelId}`, r18Bypass);
                        if (!res.ok) throw new Error('Network response was not ok');
                        const data = await res.json();
                        return data.volumeJp.map((v) => v.volumeId);
                    } catch (error) {
                        NotificationUtils.showError(`Failed to fetch data for ID ${novelId}, attempt ${attempts + 1}${tail}`);
                        if (attempts < 2) await new Promise((r) => setTimeout(r, 1000));
                    }
                }
                return [];
            };

            const jobs = [];
            let failed = false;

            switch (pageType) {
                case 'wenkus': {
                    // 列表页：每个 /wenku/{id} 链接 → 拉卷目录 → 每卷一个 wenku 任务
                    await Promise.all(
                        TaskUtils.wenkuIds().map(async (id) => {
                            const volumes = await wenkuVolumes(id);
                            volumes.forEach((volumeId) => jobs.push({
                                task: TaskUtils.wenkuLinkBuilder(id, volumeId, level),
                                description: volumeId,
                            }));
                        })
                    );
                    await StorageUtils.addJobs(storeKey, jobs);
                    break;
                }
                case 'wenku': {
                    await clickSiteQueueButtons();
                    break;
                }
                case 'novels': {
                    try {
                        const res = await script.fetch(`${window.location.origin}${TaskUtils.webSearchApi(webLimit)}`, r18Bypass);
                        if (!res.ok) throw new Error('Network response was not ok');
                        const data = await res.json();
                        const splitJobs = await split(toJobs(data.items));
                        await StorageUtils.addJobs(storeKey, splitJobs);
                        jobs.push(...splitJobs);
                    } catch (error) {
                        failed = true;
                        NotificationUtils.showError('Failed to fetch web search results.');
                    }
                    break;
                }
                case 'novel': {
                    try {
                        const statsRe = /总计 (\d+) \/ 百度 (\d+) \/ 有道 (\d+) \/ GPT (\d+) \/ Sakura (\d+)/;
                        const statSpan = [...document.querySelectorAll('span.n-text')].find((span) => statsRe.test(span.textContent));
                        if (!statSpan) throw new Error('无法找到统计信息');
                        if (document.title.includes('轻小说机翻机器人')) throw new Error('小说页尚未载入');
                        const matched = statSpan.textContent.match(statsRe);
                        const novel = {
                            url: window.location.pathname.split('/novel')[1],
                            description: document.title,
                            total: matched[1],
                            sakura: matched[5],
                        };
                        const splitJobs = await split([novel]);
                        await StorageUtils.addJobs(storeKey, splitJobs);
                        jobs.push(...splitJobs);
                    } catch (error) {
                        failed = true;
                        NotificationUtils.showError(`Failed to fetch data for ${document.title}.`);
                    }
                    break;
                }
                case 'favorite-web': {
                    const pageUrl = new URL(window.location.href);
                    const folderId = pageUrl.pathname.endsWith('/web') ? 'default' : pageUrl.pathname.split('/').pop();
                    let page = 0;
                    let tries = 0;
                    while (true) {
                        let novelCount = 0;
                        try {
                            const res = await script.fetch(`${pageUrl.origin}/api/user/favored-web/${folderId}?page=${page}&pageSize=90&sort=update`);
                            const data = await res.json();
                            const novels = toJobs(data.items);
                            novelCount = novels.length;
                            const tasks = await split(novels);
                            await StorageUtils.addJobs(storeKey, tasks);
                            jobs.push(...tasks);
                            // 页码文案的 3*page+1/-3 是上游原文（与 pageSize=90 并不一致），钉住
                            NotificationUtils.showSuccess(`成功排队 ${3 * page + 1}-${3 * page + 3}页, 共${tasks.length}个任务`);
                        } catch (error) {
                            console.log(error);
                            NotificationUtils.showError(`Failed to fetch data for ${folderId}, page ${page + 1}.`);
                            if (tries++ > 3) break;
                            continue;
                        }
                        if (novelCount < 90) break;
                        page++;
                    }
                    break;
                }
                case 'favorite-wenku': {
                    const pageUrl = new URL(window.location.href);
                    const folderId = pageUrl.pathname.endsWith('/wenku') ? 'default' : pageUrl.pathname.split('/').pop();
                    let page = 0;
                    let tries = 0;
                    while (true) {
                        let novelCount = 0;
                        try {
                            const res = await script.fetch(`${pageUrl.origin}/api/user/favored-wenku/${folderId}?page=${page}&pageSize=72&sort=update`);
                            const data = await res.json();
                            const ids = data.items.map((n) => n.id);
                            novelCount = ids.length;
                            const tasks = [];
                            await Promise.all(ids.map(async (id) => {
                                const volumes = await wenkuVolumes(id, ':');
                                volumes.forEach((volumeId) => tasks.push({
                                    task: TaskUtils.wenkuLinkBuilder(id, volumeId, level),
                                    description: volumeId,
                                }));
                            }));
                            await StorageUtils.addJobs(storeKey, tasks);
                            jobs.push(...tasks);
                            NotificationUtils.showSuccess(`成功排队 ${3 * page + 1}-${3 * page + 3}页, 共${tasks.length}本小说`);
                        } catch (error) {
                            console.log(error);
                            NotificationUtils.showError(`Failed to fetch data for ${folderId}, page ${page + 1}.`);
                            // 上游 quirk：tries 从不自增 → 持续报错时这一页会无限重试（现状钉住）
                            if (tries > 3) break;
                            continue;
                        }
                        if (novelCount < 72) break;
                        page++;
                    }
                    break;
                }
                default: { }
            }
            if (failed) return;
            const uniqueBooks = new Set(jobs.map((j) => j.description));
            NotificationUtils.showSuccess(`排队成功 : 共 ${uniqueBooks.size} 本小说, 均分 ${jobs.length} 分段.`);
        },
    };

    const moduleQueueGPTV2 = {
        name: '排队GPT v2',
        type: 'onclick',
        whitelist: ['/wenku', '/novel', '/favorite/web'],
        progress: { percentage: 0, info: '' },
        settings: [
            newNumberSetting('单次撷取web数量(可破限)', 20),
            newNumberSetting('撷取单页wenku数量(deving)', 20),
            newSelectSetting('模式', ['常规', '过期', '重翻'], '常规'),
            newSelectSetting('分段', ['智能', '固定'], '智能'),
            newNumberSetting('智能均分任务上限', 1000),
            newNumberSetting('智能均分章节下限', 5),
            newNumberSetting('固定均分任务', 6),
            newBooleanSetting('R18(需登入)', true),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            const webLimit = getModuleSetting(cfg, '单次撷取web数量(可破限)') || 20;
            const pair = getModuleSetting(cfg, '固定均分任务') || 6;
            const smartJobLimit = getModuleSetting(cfg, '智能均分任务上限') || 1000;
            const smartChapterLimit = getModuleSetting(cfg, '智能均分章节下限') || 5;
            const pageType = TaskUtils.getTypeString(window.location.pathname);
            const mode = getModuleSetting(cfg, '模式') || '常规';
            const sepMode = getModuleSetting(cfg, '分段') || '智能';
            const r18Bypass = getModuleSetting(cfg, 'R18(需登入)');
            const level = SettingUtils.getTranslateMode(mode);
            const storeKey = StorageUtils.gpt;

            // 文库详情页借用站点自己的排队按钮：先按模式点一遍，再点「排队GPT」
            const clickSiteQueueButtons = async () => {
                await TaskUtils.clickButtons(mode);
                await TaskUtils.clickButtons('排队GPT');
            };
            const split = (novels) => (sepMode === '智能')
                ? TaskUtils.assignTasksSmart(novels, smartJobLimit, smartChapterLimit, level)
                : TaskUtils.assignTasksStatic(novels, pair, level);
            const toJobs = (novels) => novels.map((item) => ({
                url: `/${item.providerId}/${item.novelId}`,
                description: item.titleZh ?? item.titleJp,
                total: item.total,
                gpt: item.gpt,
            }));

            // 卷目录：失败重试 3 次（间隔 1s）；GPT 模块的错误文案按上游原文统一冒号收尾
            const wenkuVolumes = async (novelId) => {
                for (let attempts = 0; attempts < 3; attempts++) {
                    try {
                        const res = await script.fetch(`${window.location.origin}/api/wenku/${novelId}`, r18Bypass);
                        if (!res.ok) throw new Error('Network response was not ok');
                        const data = await res.json();
                        return data.volumeJp.map((v) => v.volumeId);
                    } catch (error) {
                        NotificationUtils.showError(`Failed to fetch data for ID ${novelId}, attempt ${attempts + 1}:`);
                        if (attempts < 2) await new Promise((r) => setTimeout(r, 1000));
                    }
                }
                return [];
            };

            const jobs = [];
            let failed = false;

            switch (pageType) {
                case 'wenkus': {
                    // 列表页：每个 /wenku/{id} 链接 → 拉卷目录 → 每卷一个 wenku 任务
                    await Promise.all(
                        TaskUtils.wenkuIds().map(async (id) => {
                            const volumes = await wenkuVolumes(id);
                            volumes.forEach((volumeId) => jobs.push({
                                task: TaskUtils.wenkuLinkBuilder(id, volumeId, level),
                                description: volumeId,
                            }));
                        })
                    );
                    await StorageUtils.addJobs(storeKey, jobs);
                    break;
                }
                case 'wenku': {
                    await clickSiteQueueButtons();
                    break;
                }
                case 'novels': {
                    try {
                        const res = await script.fetch(`${window.location.origin}${TaskUtils.webSearchApi(webLimit)}`, r18Bypass);
                        if (!res.ok) throw new Error('Network response was not ok');
                        const data = await res.json();
                        const splitJobs = await split(toJobs(data.items));
                        await StorageUtils.addJobs(storeKey, splitJobs);
                        jobs.push(...splitJobs);
                    } catch (error) {
                        failed = true;
                        NotificationUtils.showError('Failed to fetch web search results.');
                    }
                    break;
                }
                case 'novel': {
                    try {
                        const statsRe = /总计 (\d+) \/ 百度 (\d+) \/ 有道 (\d+) \/ GPT (\d+) \/ Sakura (\d+)/;
                        const statSpan = [...document.querySelectorAll('span.n-text')].find((span) => statsRe.test(span.textContent));
                        if (!statSpan) throw new Error('无法找到统计信息');
                        if (document.title.includes('轻小说机翻机器人')) throw new Error('小说页尚未载入');
                        const matched = statSpan.textContent.match(statsRe);
                        const novel = {
                            url: window.location.pathname.split('/novel')[1],
                            description: document.title,
                            total: matched[1],
                            gpt: matched[4],
                        };
                        const splitJobs = await split([novel]);
                        await StorageUtils.addJobs(storeKey, splitJobs);
                        jobs.push(...splitJobs);
                    } catch (error) {
                        failed = true;
                        NotificationUtils.showError(`Failed to fetch data for ${document.title}.`);
                    }
                    break;
                }
                case 'favorite-web': {
                    const pageUrl = new URL(window.location.href);
                    const folderId = pageUrl.pathname.endsWith('/web') ? 'default' : pageUrl.pathname.split('/').pop();
                    let page = 0;
                    let tries = 0;
                    while (true) {
                        let novelCount = 0;
                        try {
                            const res = await script.fetch(`${pageUrl.origin}/api/user/favored-web/${folderId}?page=${page}&pageSize=90&sort=update`);
                            const data = await res.json();
                            const novels = toJobs(data.items);
                            novelCount = novels.length;
                            const tasks = await split(novels);
                            await StorageUtils.addJobs(storeKey, tasks);
                            jobs.push(...tasks);
                            // 页码文案的 3*page+1/-3 是上游原文（与 pageSize=90 并不一致），钉住
                            NotificationUtils.showSuccess(`成功排队 ${3 * page + 1}-${3 * page + 3}页, 共${novelCount}本小说`);
                        } catch (error) {
                            console.log(error);
                            NotificationUtils.showError(`Failed to fetch data for ${folderId}, page ${page + 1}.`);
                            if (tries++ > 3) break;
                            continue;
                        }
                        if (novelCount < 90) break;
                        page++;
                    }
                    break;
                }
                case 'favorite-wenku': {
                    const pageUrl = new URL(window.location.href);
                    const folderId = pageUrl.pathname.endsWith('/wenku') ? 'default' : pageUrl.pathname.split('/').pop();
                    let page = 0;
                    let tries = 0;
                    while (true) {
                        let novelCount = 0;
                        try {
                            const res = await script.fetch(`${pageUrl.origin}/api/user/favored-wenku/${folderId}?page=${page}&pageSize=72&sort=update`);
                            const data = await res.json();
                            const ids = data.items.map((n) => n.id);
                            novelCount = ids.length;
                            const tasks = [];
                            await Promise.all(ids.map(async (id) => {
                                const volumes = await wenkuVolumes(id);
                                volumes.forEach((volumeId) => tasks.push({
                                    task: TaskUtils.wenkuLinkBuilder(id, volumeId, level),
                                    description: volumeId,
                                }));
                            }));
                            await StorageUtils.addJobs(storeKey, tasks);
                            jobs.push(...tasks);
                            NotificationUtils.showSuccess(`成功排队 ${3 * page + 1}-${3 * page + 3}页, 共${tasks.length}本小说`);
                        } catch (error) {
                            console.log(error);
                            NotificationUtils.showError(`Failed to fetch data for ${folderId}, page ${page + 1}.`);
                            // 上游 quirk：tries 从不自增 → 持续报错时这一页会无限重试（现状钉住）
                            if (tries > 3) break;
                            continue;
                        }
                        if (novelCount < 72) break;
                        page++;
                    }
                    break;
                }
                default: { }
            }
            if (failed) return;
            const uniqueBooks = new Set(jobs.map((j) => j.description));
            NotificationUtils.showSuccess(`排队成功 : 共 ${uniqueBooks.size} 本小说, 均分 ${jobs.length} 分段.`);
        },
    };

    const moduleAutoRetry = {
        name: '自动重试',
        type: 'keep',
        whitelist: '/workspace/*',
        settings: [
            newNumberSetting('最大重试次数', 99),
            newBooleanSetting('置顶重试任务', false),
            newBooleanSetting('重启翻译器', true),
        ],
        _attempts: 0,
        _lastRun: 0,
        _interval: 1000,
        run: async function (cfg) {
            const now = Date.now();
            if (now - this._lastRun < this._interval) return;
            this._lastRun = now;

            const maxAttempts = getModuleSetting(cfg, '最大重试次数') || 99;
            // 「重启翻译器」是布尔开关：直接读布尔值（历史上这里写成了 `|| 3`，导致关掉也会照样重启）
            const relaunch = getModuleSetting(cfg, '重启翻译器') === true;
            const moveToTop = getModuleSetting(cfg, '置顶重试任务');

            // 手动点了页面上任意按钮（说明用户在亲自操作）→ 清零重试计数，重新给满预算
            if (!this._boundClickHandler) {
                this._boundClickHandler = (e) => {
                    if (String(e.target.tagName).toUpperCase() === 'BUTTON') {
                        this._attempts = 0;
                    }
                };
                document.addEventListener('click', this._boundClickHandler);
            }

            const listItems = document.querySelectorAll('.n-list-item');
            const unfinished = [...listItems].filter((item) => {
                const desc = item.querySelector('.n-thing-main__description');
                return desc && desc.textContent.includes('未完成');
            });

            const retryTasks = async (attempts) => {
                // 有任务在跑（页面存在文案全等『停止』的按钮）时不插手
                const hasStop = [...document.querySelectorAll('button')].some((b) => b.textContent === '停止');
                if (hasStop) return attempts;
                const retryBtn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('重试未完成任务'));
                if (!retryBtn) return attempts;
                for (let i = 0; i < Math.min(unfinished.length, listItems.length); i++) {
                    retryBtn.click();
                }
                if (moveToTop) {
                    TaskUtils.clickTaskMoveToTop(unfinished.length);
                }
                return attempts + 1;
            };

            if (unfinished.length > 0 && this._attempts < maxAttempts) {
                this._attempts = await retryTasks(this._attempts);
                script.delay(10);
                // 即使 retry 按钮不存在，只要页上有未完成条目，每轮也会触发一次「启动翻译器」
                if (relaunch) {
                    script.runModule('启动翻译器');
                }
            }
        },
    };

    const moduleClearJobs = {
        name: '清空任务',
        type: 'onclick',
        whitelist: '/workspace/*',
        settings: [
            newBooleanSetting('确认清空', true),
            newBooleanSetting('仅清空已完成', false),
        ],
        run: async function (cfg) {
            const key = window.location.pathname.includes('workspace/sakura') ? StorageUtils.sakura
                : (window.location.pathname.includes('workspace/gpt') ? StorageUtils.gpt : null);
            if (!key) {
                NotificationUtils.showError('无法确定工作区类型');
                return;
            }
            // 上游未实现的死设置：勾上只提示、不动数据（现状钉住，见 .e2e-collect-tasks.js）
            if (getModuleSetting(cfg, '仅清空已完成')) {
                NotificationUtils.showWarning('仅清空已完成功能需配合网站API');
                return;
            }

            const data = await StorageUtils._getData(key);
            const removedCount = data.jobs.length;
            if (getModuleSetting(cfg, '确认清空') && removedCount > 0) {
                if (!confirm(`确定要清空 ${removedCount} 个任务吗？此操作不可恢复！`)) {
                    NotificationUtils.showWarning('已取消清空');
                    return;
                }
            }
            data.jobs = [];
            await StorageUtils._setData(key, data);
            NotificationUtils.showSuccess(`已清空 ${removedCount} 个任务`);
        },
    };

    const moduleSyncStorage = {
        name: '资料同步',
        type: 'onclick',
        whitelist: '/workspace/*',
        hidden: true,
        settings: [
            newStringSetting('bind', 'none')
        ],
        run: async function (cfg) {
            // 上游未实现的占位模块：保持 no-op（契约钉在 .e2e-sync-storage.js）
        },
    }

    const moduleFillGlossary = {
        name: '填充术语表',
        type: 'onclick',
        whitelist: '/novel',
        settings: [
            newTextareaSetting('术语表', ''),
            newBooleanSetting('追加模式', true),
            newBooleanSetting('页面可视化反馈', true),
            newBooleanSetting('自动翻页至末页', false),
            newNumberSetting('翻页上限', 20),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            const glossaryText = getModuleSetting(cfg, '术语表') || '';
            const isAppend = getModuleSetting(cfg, '追加模式');
            const visualFeedback = getModuleSetting(cfg, '页面可视化反馈');
            const autoPaginate = getModuleSetting(cfg, '自动翻页至末页') === true;
            const maxPages = Math.max(1, Number(getModuleSetting(cfg, '翻页上限')) || 20);

            if (!glossaryText.trim()) {
                NotificationUtils.showWarning('术语表为空');
                return;
            }

            // 每行 `原文 => 译文`；整行是 JSON 对象也能吃（合并进表）
            const newGlossary = {};
            glossaryText.split('\n').forEach((line) => {
                const trimmed = line.trim();
                if (!trimmed) return;
                const pair = trimmed.split('=>');
                if (pair.length === 2) {
                    newGlossary[pair[0].trim()] = pair[1].trim();
                    return;
                }
                try {
                    const obj = JSON.parse(trimmed);
                    if (typeof obj === 'object') {
                        Object.assign(newGlossary, obj);
                    }
                } catch (e) { }
            });
            if (Object.keys(newGlossary).length === 0) {
                NotificationUtils.showError('未能解析任何术语 (格式: 日文 => 中文)');
                return;
            }

            // 当前页的小说条目（站内 /novel/{provider}/{id} 链接，去重）；
            // 容器链第一环是自定义元素 n-list-item（无点号，上游如此），落空再走 .n-list-item
            const collectNovels = () => {
                const seen = new Set();
                const novels = [];
                [...document.querySelectorAll('a')].forEach((a) => {
                    try {
                        const url = new URL(a.href);
                        if (url.origin !== window.location.origin) return;
                        const match = url.pathname.match(/^\/novel\/([^/]+)\/([^/]+)$/);
                        if (!match) return;
                        const id = `${match[1]}/${match[2]}`;
                        if (seen.has(id)) return;
                        seen.add(id);
                        const container = a.closest('n-list-item')
                            || a.closest('.n-list-item')
                            || a.closest('.novel-card')
                            || a.closest('div');
                        novels.push({ providerId: match[1], novelId: match[2], id, container });
                    } catch (e) { }
                });
                return novels;
            };

            // 先收一遍当前页 novels 用于 confirm 提示；开启翻页时也告知用户范围
            const firstPage = collectNovels();
            if (firstPage.length === 0) {
                NotificationUtils.showWarning('未在当前页面找到小说条目');
                return;
            }
            const paginateHint = autoPaginate
                ? `\n\n将自动翻到第 1/${maxPages} 页（每页点「下一页」后等新列表载入；点不到/按钮禁用/翻不动会自动停止）。`
                : '';
            // 指南绝对禁止「改原文/插控制符操控翻译」（如 rem0 => …）：批量直写没有预览 UI，至少在确认里点名
            const tamperedCount = Object.keys(newGlossary).filter((src) => GlossaryEngine.looksLikeSourceTampering(src)).length;
            const tamperHint = tamperedCount > 0 ? `\n\n⚠ 其中 ${tamperedCount} 条疑似改原文/含控制符（指南绝对禁止，建议从输入里剔除）` : '';
            if (!confirm(`确定要为当前页面的 ${firstPage.length} 本小说${isAppend ? '追加' : '填充'}术语表吗？\n(包含 ${Object.keys(newGlossary).length} 个术语)${paginateHint}${tamperHint}`)) {
                return;
            }

            if (visualFeedback) {
                document.querySelectorAll('.ntr-glossary-badge').forEach((el) => el.remove());
            }

            let successCount = 0;
            let failCount = 0;
            let pagesProcessed = 0;
            let stoppedReason = null;   // 'no-next' | 'disabled' | 'max-pages' | 'empty' | 'stuck'

            const setBadge = (container, status, message) => {
                if (!visualFeedback || !container) return;
                let badge = container.querySelector('.ntr-glossary-badge');
                if (!badge) {
                    badge = document.createElement('span');
                    const flex = container.querySelector('n-flex') || container.querySelector('.n-flex') || container;
                    if (flex.firstElementChild) {
                        flex.insertBefore(badge, flex.firstElementChild);
                    } else {
                        flex.appendChild(badge);
                    }
                }
                badge.className = 'ntr-glossary-badge ntr-glossary-' + status;
                badge.title = message;
                badge.textContent = { success: '✅', fail: '❌', pending: '⏳' }[status] || '⏳';
            };

            // 下一页按钮：真站（naive-ui）的按钮只有图标，首个是「上一页」、末个是「下一页」，
            // 禁用态在 class（--disabled）上而非 disabled 属性；回落找文本含 下/› 或 aria next 的按钮
            const findNextButton = () => {
                const pag = [...document.querySelectorAll('.n-pagination')].find((p) => p.offsetWidth || p.offsetHeight);
                if (pag) {
                    const btns = [...pag.querySelectorAll('.n-pagination-item--button')];
                    if (btns.length) return btns[btns.length - 1];
                }
                return [...document.querySelectorAll('.n-pagination button')].find((btn) => {
                    const text = (btn.textContent || '').trim();
                    const aria = (btn.getAttribute('aria-label') || '').toLowerCase();
                    return text.includes('下') || text.includes('›') || aria.includes('next');
                }) || null;
            };
            const nextDisabled = (el) => el.disabled === true || el.getAttribute('disabled') !== null || el.classList.contains('n-pagination-item--disabled');
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

            // 当前页「签名」：条目数 + 首末条目 id —— 用来确认列表真的翻过去了
            const pageSignature = () => {
                const list = collectNovels();
                return `${list.length}|${list[0] ? list[0].id : ''}|${list[list.length - 1] ? list[list.length - 1].id : ''}`;
            };

            const processCurrentPage = async () => {
                const novels = collectNovels();
                if (novels.length === 0) {
                    stoppedReason = 'empty';
                    return;
                }
                pagesProcessed += 1;
                for (const novel of novels) {
                    if (visualFeedback && novel.container) {
                        setBadge(novel.container, 'pending', '正在填充术语表...');
                    }
                    try {
                        let finalGlossary = newGlossary;
                        if (isAppend) {
                            // 追加模式：先取站点现表，新值优先合并
                            const getRes = await script.fetch(`${window.location.origin}/api/novel/${novel.providerId}/${novel.novelId}`);
                            if (!getRes.ok) throw new Error('Fetch failed');
                            const data = await getRes.json();
                            finalGlossary = Object.assign({}, data.glossary || {}, newGlossary);
                        }
                        const putRes = await script.fetch(`${window.location.origin}/api/novel/${novel.providerId}/${novel.novelId}/glossary`, true, {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(finalGlossary),
                        });
                        if (putRes.ok) {
                            successCount++;
                            setBadge(novel.container, 'success', `术语表填充成功 (+${Object.keys(newGlossary).length} 术语)`);
                        } else {
                            failCount++;
                            setBadge(novel.container, 'fail', `术语表填充失败: HTTP ${putRes.status}`);
                        }
                    } catch (e) {
                        console.error(`Failed to update glossary for ${novel.id}:`, e);
                        failCount++;
                        setBadge(novel.container, 'fail', `术语表填充失败: ${e.message || '网络错误'}`);
                    }
                }
            };

            await processCurrentPage();

            if (autoPaginate) {
                while (pagesProcessed < maxPages) {
                    const nextBtn = findNextButton();
                    if (!nextBtn) { stoppedReason = 'no-next'; break; }
                    if (nextDisabled(nextBtn)) { stoppedReason = 'disabled'; break; }
                    const sigBefore = pageSignature();
                    nextBtn.click();
                    // 等列表真的翻过去（真站是异步路由 + 请求，可能超过 1 秒）→ 最长 10s；没变就停，防同一页重复填
                    let flipped = false;
                    for (let waited = 0; waited < 10000; waited += 250) {
                        await sleep(250);
                        if (pageSignature() !== sigBefore) { flipped = true; break; }
                    }
                    if (!flipped) { stoppedReason = 'stuck'; break; }
                    await sleep(400);   // 列表刚换上，稍等渲染稳定再收
                    await processCurrentPage();
                }
                if (!stoppedReason && pagesProcessed >= maxPages) stoppedReason = 'max-pages';
            }

            const stopText = stoppedReason
                ? ({ 'no-next': '已到末页', 'disabled': '下一页按钮不可用', 'max-pages': '达到翻页上限', 'empty': '翻到空白页', 'stuck': '列表没有翻动' }[stoppedReason] || stoppedReason)
                : null;
            const tailMsg = autoPaginate ? `，翻页 ${pagesProcessed} 页${stopText ? `（停止：${stopText}）` : ''}` : '';
            if (failCount === 0) {
                NotificationUtils.showSuccess(`成功填充 ${successCount} 本小说的术语表${tailMsg}`);
            } else {
                NotificationUtils.showWarning(`填充完成: ${successCount} 成功, ${failCount} 失败${tailMsg}`);
            }
        },
    };

    // -----------------------------------
    // AI 术语表 modules
    // -----------------------------------

    // 术语模块的「译文来源」只保留 LLM 槽（gpt/sakura）；历史配置里的 baidu/youdao 回落到 gpt
    const LLM_TRANSLATORS = ['gpt', 'sakura'];
    const normalizeGlossaryTranslator = (value) => {
        const v = String(value || '').trim();
        return LLM_TRANSLATORS.includes(v) ? v : 'gpt';
    };

    // 公共：解析 LLM workers（勾选「使用临时端点」时用临时端点，否则取工作区 GPT 翻译器）
    const resolveGlossaryWorkers = async (cfg) => {
        const useTest = getModuleSetting(cfg, '使用临时端点') === true;
        const testEndpoint = useTest ? (getModuleSetting(cfg, '临时端点') || '').trim() : '';
        if (testEndpoint) {
            const testModel = (getModuleSetting(cfg, '临时模型') || '').trim();
            if (testModel === '') return [];   // 用临时端点时必须填模型，由调用方提示
            return [{
                id: '临时端点',
                model: testModel,
                endpoint: testEndpoint,
                key: (getModuleSetting(cfg, '临时Key') || '').trim() || 'no_key_required',
            }];
        }
        const wanted = (getModuleSetting(cfg, '翻译器') || '').trim();
        const workers = readWorkspaceGptWorkers()
            .filter((w) => !wanted || w.id === wanted)
            .filter((w) => w.endpoint && w.model)
            .map((w) => ({ id: w.id, model: w.model, endpoint: w.endpoint, key: w.key }));
        return workers;
    };

    // 公共：确定提取目标（小说页 -> 网页小说；文库页 -> 文库小说；其它页面 -> 从本地书架选择）
    const resolveGlossaryTarget = async () => {
        const m = window.location.pathname.match(/^\/novel\/([^/]+)\/([^/]+)/);
        if (m) {
            return { kind: 'web', providerId: m[1], novelId: m[2] };
        }
        const mw = window.location.pathname.match(/^\/wenku\/([^/]+)/);
        if (mw) {
            return { kind: 'wenku', novelId: mw[1] };
        }
        const volumes = await GlossaryTargets.listLocalVolumes();
        if (volumes.length === 0) {
            NotificationUtils.showWarning('未找到本地卷（可在书架本地上传 EPUB/TXT）');
            return undefined;
        }
        const picked = await GlossaryUI.pick({
            title: '选择本地卷',
            options: volumes,
            renderOption: (v) => `${v.id}（${v.chapters} 章，术语 ${v.glossaryCount} 条）`,
        });
        if (!picked) return undefined;
        return { kind: 'local', volumeId: picked.id };
    };

    // 公共：抓取正文
    const loadGlossarySourceText = async (target, onProgress) => {
        if (target.kind === 'web') {
            const novelRes = await script.fetch(`${window.location.origin}/api/novel/${target.providerId}/${target.novelId}`);
            const novel = novelRes.ok ? await novelRes.json() : {};
            target.title = novel.titleZh || novel.titleJp || target.novelId;
            const filename = `jp.${String(target.title).replace(/[\/|\\:*?"<>]/g, '')}.txt`;
            const params = new URLSearchParams({ mode: 'jp', translationsMode: 'parallel', type: 'txt', filename });
            const res = await script.fetch(`${window.location.origin}/api/novel/${target.providerId}/${target.novelId}/file?${params}`);
            if (!res.ok) throw new Error(`下载原文失败: HTTP ${res.status}`);
            return { text: await res.text() };
        }
        if (target.kind === 'wenku') {
            const novelRes = await script.fetch(`${window.location.origin}/api/wenku/${target.novelId}`);
            if (!novelRes.ok) throw new Error(`读取文库信息失败: HTTP ${novelRes.status}`);
            const novel = await novelRes.json();
            target.title = novel.titleZh || novel.title || target.novelId;
            const volumes = novel.volumeJp || [];
            if (volumes.length === 0) throw new Error('该文库小说没有已上传的日文卷');
            // 文库没有原文下载接口（服务端拒绝 mode=jp），走翻译任务的只读链路取原段落：
            // 卷目录（toc）-> 每章 chapter-task -> paragraphJp
            const parts = [];
            for (let vi = 0; vi < volumes.length; vi++) {
                const volumeId = volumes[vi].volumeId;
                if (onProgress) onProgress(`抓取正文：卷 ${vi + 1}/${volumes.length}（${volumeId}）`);
                const taskRes = await script.fetch(`${window.location.origin}/api/wenku/${target.novelId}/translate-v2/gpt/${encodeURIComponent(volumeId)}`);
                if (!taskRes.ok) throw new Error(`读取卷目录失败（${volumeId}）: HTTP ${taskRes.status}`);
                const task = await taskRes.json();
                const toc = task.toc || [];
                for (let ci = 0; ci < toc.length; ci++) {
                    if (onProgress && toc.length > 1) onProgress(`抓取正文：卷 ${vi + 1}/${volumes.length} · 章 ${ci + 1}/${toc.length}`);
                    const chRes = await script.fetch(`${window.location.origin}/api/wenku/${target.novelId}/translate-v2/gpt/${encodeURIComponent(volumeId)}/chapter-task/${toc[ci].chapterId}`);
                    if (!chRes.ok) continue;
                    const dto = await chRes.json();
                    parts.push((dto.paragraphJp || []).join('\n'));
                }
            }
            return { text: parts.join('\n\n') };
        }
        if (target.kind === 'local') {
            target.title = target.volumeId;
            const { text } = await GlossaryTargets.loadLocalVolumeText(target.volumeId);
            return { text };
        }
        throw new Error('未知目标');
    };

    // 公共：跑一次提取（含进度浮窗）
    const runGlossaryExtraction = async (cfg, target) => {
        const workers = await resolveGlossaryWorkers(cfg);
        if (workers.length === 0) {
            const useTest = getModuleSetting(cfg, '使用临时端点') === true;
            const testEndpoint = useTest ? (getModuleSetting(cfg, '临时端点') || '').trim() : '';
            const wantedWorker = (getModuleSetting(cfg, '翻译器') || '').trim();
            if (testEndpoint) NotificationUtils.showError('已勾选「使用临时端点」，但「临时模型」没填：临时端点需要模型名才能用');
            else if (useTest) NotificationUtils.showError('已勾选「使用临时端点」，但「临时端点」是空的：请展开填好端点，或取消勾选改用翻译器下拉');
            else if (wantedWorker) NotificationUtils.showError(`没有可用的翻译器「${wantedWorker}」：工作区里可能已删除或没填端点，也可改选「全部（自动轮换）」`);
            else NotificationUtils.showError('没有可用的翻译器：请在工作区添加 GPT 翻译器，或勾选「使用临时端点」并填好端点/模型');
            return undefined;
        }
        const sourceLanguage = getModuleSetting(cfg, '原文语言') || 'JA';
        const maxLines = Number(getModuleSetting(cfg, '行数上限')) || 0;
        const timeoutMs = Math.max(5, Number(getModuleSetting(cfg, '逾时(秒)')) || 300) * 1000;
        const concurrency = Math.max(1, Number(getModuleSetting(cfg, '并发')) || 2);
        const maxRounds = Math.max(1, Number(getModuleSetting(cfg, '最大轮数')) || 3);
        const budgetChars = Math.max(200, Number(getModuleSetting(cfg, '分块字数')) || 3000);
        const rpm = Math.max(0, Number(getModuleSetting(cfg, 'RPM')) || 0);
        const maxTokens = Math.max(0, Number(getModuleSetting(cfg, '输出上限')) || 0);
        const seedPolish = getModuleSetting(cfg, '种子补漏') !== false;
        const maxSeedRounds = Math.max(1, Number(getModuleSetting(cfg, '种子轮数')) || 3);
        const verifyEnabled = getModuleSetting(cfg, '证据核实') !== false;

        let stopped = false;
        const progress = GlossaryUI.status(`AI提取术语表 - ${GlossaryTargets.describe(target)}`, { onStop: () => { stopped = true; } });
        try {
            progress.update('抓取正文…');
            const { text } = await loadGlossarySourceText(target, (msg) => progress.update(msg));
            let lines = GlossaryEngine.splitLines(text)
                .filter((line) => GlossaryEngine.languageFilter(line, sourceLanguage))
                .filter((line) => !GlossaryEngine.ruleFilter(line));
            if (maxLines > 0) lines = lines.slice(0, maxLines);
            if (lines.length === 0) {
                progress.close();
                NotificationUtils.showWarning('正文为空或语言过滤后无内容');
                return undefined;
            }
            progress.update(`准备提取：${lines.length} 行 / ${workers.length} 个翻译器`);

            const requester = GlossaryEngine.createRequester(workers, { timeoutMs, rps: concurrency, rpm, maxTokens });
            const result = await GlossaryEngine.runJob({
                lines,
                callLLM: (messages) => requester.call(messages),
                options: { budgetChars, maxRounds, concurrency, targetLanguage: '中文', seedPolish, maxSeedRounds },
                shouldStop: () => stopped,
                onProgress: (p) => {
                    // 种子补漏是收尾阶段：不参与"第几轮"和块数进度（总块数是主轮的）
                    if (String(p.phase || '').startsWith('seed-')) {
                        if (p.phase === 'seed-start') progress.update(`种子补漏 第 ${p.seedRound || 1} 轮：${p.seedCount} 个种子 / ${p.totalChunks} 块`);
                        else if (p.phase !== 'seed-chunk-cached') progress.update(`种子补漏 第 ${p.seedRound || 1} 轮：第 ${(p.chunkIndex || 0) + 1} 块完成`);
                        return;
                    }
                    const ratio = p.totalChunks ? p.chunksDone / Math.max(1, p.totalChunks) : 0;
                    progress.update(`第 ${p.round}/${p.maxRounds} 轮 · 完成 ${p.chunksDone} 块 / 失败 ${p.chunksFailed} 块 · 待处理 ${p.pendingLines} 行`, ratio);
                },
            });
            // 证据化核实（可选）：对提取结果做正向判定；剔除建议只标记不删，进弹层人工复核
            let finalEntries = result.glossary;
            let verifyStats = null;
            if (verifyEnabled && !stopped && finalEntries.length > 0) {
                progress.update(`证据核实：${finalEntries.length} 条…`);
                verifyStats = await GlossaryEngine.verifyEntries({
                    entries: finalEntries,
                    lines,
                    call: (messages) => requester.call(messages),
                    concurrency,
                    shouldStop: () => stopped,
                    onProgress: (p) => progress.update(`证据核实 ${p.done}/${p.total} 批（已判定 ${p.marks} 条）`, p.done / Math.max(1, p.total)),
                });
                finalEntries = verifyStats.entries.map((e) => (e.verifyDrop
                    ? { ...e, suspect: [...(e.suspect || []), `核实建议剔除${e.verified && e.verified.reason ? `：${e.verified.reason}` : ''}`] }
                    : e));
            }
            progress.close();

            const failedHint = result.pendingLines > 0 ? `（${result.pendingLines} 行未能提取）` : '';
            const drop = result.dropped || {};
            const dropHint = (drop.punct || drop.honorific) ? `（清洗：整句 ${drop.punct || 0} 条 / 敬称 ${drop.honorific || 0} 条）` : '';
            const seedHint = result.seedRounds > 0 ? `（种子补漏 ${result.seedRounds} 轮）` : '';
            const verifyHint = verifyStats ? `（核实：保留 ${verifyStats.kept} / 建议剔除 ${verifyStats.dropped}${verifyStats.failedBatches ? ` / 失败 ${verifyStats.failedBatches} 批` : ''}）` : '';
            NotificationUtils.showSuccess(`提取完成：${finalEntries.length} 条术语${failedHint}${dropHint}${seedHint}${verifyHint}`);

            const existing = await GlossaryTargets.loadGlossary(target);
            const mode = (getModuleSetting(cfg, '模式') || '预览') === '写入' ? 'merge' : 'preview';
            GlossaryUI.open({
                title: `AI提取术语表 - ${target.title || GlossaryTargets.describe(target)}（${finalEntries.length} 条）`,
                target,
                entries: finalEntries,
                existing,
                mode,
                onWrite: (picked) => writeGlossaryMerged(target, picked),
                auditConcurrency: concurrency,   // 审计也并行（同一个「并发」设置）
                // 再次筛选：复用同一批 worker，温度 0、不发送输出上限（失败即放过，不改任何东西）
                onAudit: (auditEntries, { onProgress }) => {
                    const auditRequester = GlossaryEngine.createRequester(workers, { timeoutMs, rpm, maxTokens: 0, temperature: 0 });
                    return GlossaryEngine.auditGlossary({
                        entries: auditEntries,
                        call: (messages) => auditRequester.call(messages),
                        context: {
                            title: target.title || GlossaryTargets.describe(target),
                            snippet: lines.slice(0, 6).join(' ').slice(0, 300),
                        },
                        concurrency,     // 和提取共用同一个「并发」设置
                        onProgress,
                    });
                },
            });
            return result;
        } catch (e) {
            progress.close();
            NotificationUtils.showError(`提取失败：${e.message || e}`);
            return undefined;
        }
    };

    // 公共：抓验收回扫需要的「原文 + 译文」两边文本
    // 译文获取与站点前端一致：/file 的 translations 列表参数（priority = 取第一个有译文的翻译器）
    // 返回 { jpText, zhText, translator }；web 为整本下载，wenku 逐章取 paragraphJp/oldParagraphZh（天然对齐）
    const loadGlossaryParallelText = async (target, translator, onProgress) => {
        const zhTranslator = normalizeGlossaryTranslator(translator);
        if (target.kind === 'web') {
            const { text: jpText } = await loadGlossarySourceText(target, onProgress);
            const filename = `zh.${String(target.title || target.novelId).replace(/[\/|\\:*?"<>]/g, '')}.txt`;
            const params = new URLSearchParams({ mode: 'zh', translationsMode: 'priority', type: 'txt', filename });
            params.append('translations', zhTranslator);
            if (onProgress) onProgress(`抓取译文（${zhTranslator}）…`);
            const res = await script.fetch(`${window.location.origin}/api/novel/${target.providerId}/${target.novelId}/file?${params}`);
            if (!res.ok) throw new Error(`下载译文失败: HTTP ${res.status}`);
            return { jpText, zhText: await res.text(), translator: zhTranslator };
        }
        if (target.kind === 'wenku') {
            // 文库没有原文下载接口（服务端拒绝 mode=jp），沿用 source loader 的只读链路逐章取；
            // chapter-task 固定走 gpt 路径，translator 设置对文库不生效
            const novelRes = await script.fetch(`${window.location.origin}/api/wenku/${target.novelId}`);
            if (!novelRes.ok) throw new Error(`读取文库信息失败: HTTP ${novelRes.status}`);
            const novel = await novelRes.json();
            target.title = novel.titleZh || novel.title || target.novelId;
            const volumes = novel.volumeJp || [];
            if (volumes.length === 0) throw new Error('该文库小说没有已上传的日文卷');
            const jpLines = [];
            const zhLines = [];
            for (let vi = 0; vi < volumes.length; vi++) {
                const volumeId = volumes[vi].volumeId;
                if (onProgress) onProgress(`抓取正文：卷 ${vi + 1}/${volumes.length}（${volumeId}）`);
                const taskRes = await script.fetch(`${window.location.origin}/api/wenku/${target.novelId}/translate-v2/gpt/${encodeURIComponent(volumeId)}`);
                if (!taskRes.ok) throw new Error(`读取卷目录失败（${volumeId}）: HTTP ${taskRes.status}`);
                const task = await taskRes.json();
                const toc = task.toc || [];
                for (let ci = 0; ci < toc.length; ci++) {
                    if (onProgress && toc.length > 1) onProgress(`抓取正文：卷 ${vi + 1}/${volumes.length} · 章 ${ci + 1}/${toc.length}`);
                    const chRes = await script.fetch(`${window.location.origin}/api/wenku/${target.novelId}/translate-v2/gpt/${encodeURIComponent(volumeId)}/chapter-task/${toc[ci].chapterId}`);
                    if (!chRes.ok) continue;
                    const dto = await chRes.json();
                    const jp = dto.paragraphJp || [];
                    const zh = Array.isArray(dto.oldParagraphZh) ? dto.oldParagraphZh : [];
                    jp.forEach((p, i) => {
                        jpLines.push(p);
                        zhLines.push(typeof zh[i] === 'string' ? zh[i] : '');
                    });
                }
            }
            return { jpText: jpLines.join('\n'), zhText: zhLines.join('\n'), translator: 'gpt' };
        }
        throw new Error('本地卷暂不支持验收回扫：请改用网页/文库目标');
    };

    // 公共：抓 jp-zh 对齐对（译文反推 / 修句用）
    // web 走 /file?mode=jp-zh（priority 单译文块，jp/zh 行交替）；wenku 走 chapter-task 的段落数组
    // 每对尽量带 chapterId（修句写回定位章节用；web 用标题映射 TOC，文库循环里直接有）
    const loadGlossaryAlignedPairs = async (target, translator, onProgress) => {
        const zhTranslator = normalizeGlossaryTranslator(translator);
        if (target.kind === 'web') {
            const novelRes = await script.fetch(`${window.location.origin}/api/novel/${target.providerId}/${target.novelId}`);
            const novel = novelRes.ok ? await novelRes.json() : {};
            target.title = novel.titleZh || novel.titleJp || target.novelId;
            const filename = `jz.${String(target.title).replace(/[\/|\\:*?"<>]/g, '')}.txt`;
            const params = new URLSearchParams({ mode: 'jp-zh', translationsMode: 'priority', type: 'txt', filename });
            params.append('translations', zhTranslator);
            if (onProgress) onProgress(`抓取对照文本（${zhTranslator}）…`);
            const res = await script.fetch(`${window.location.origin}/api/novel/${target.providerId}/${target.novelId}/file?${params}`);
            if (!res.ok) throw new Error(`下载对照文本失败: HTTP ${res.status}`);
            const parsed = GlossaryEngine.parseParallelText(await res.text());
            const tocMap = new Map((novel.toc || []).filter((t) => t.chapterId).map((t) => [t.titleJp, t.chapterId]));
            let unmatchedChapters = 0;
            parsed.pairs.forEach((pair) => {
                const chapterId = tocMap.get(pair.chapter);
                if (chapterId) pair.chapterId = chapterId;
                else unmatchedChapters += 1;
            });
            return { ...parsed, translator: zhTranslator, unmatchedChapters };
        }
        if (target.kind === 'wenku') {
            const novelRes = await script.fetch(`${window.location.origin}/api/wenku/${target.novelId}`);
            if (!novelRes.ok) throw new Error(`读取文库信息失败: HTTP ${novelRes.status}`);
            const novel = await novelRes.json();
            target.title = novel.titleZh || novel.title || target.novelId;
            const volumes = novel.volumeJp || [];
            if (volumes.length === 0) throw new Error('该文库小说没有已上传的日文卷');
            const pairs = [];
            let chapters = 0;
            let translationMissing = 0;
            for (let vi = 0; vi < volumes.length; vi++) {
                const volumeId = volumes[vi].volumeId;
                if (onProgress) onProgress(`抓取对照文本：卷 ${vi + 1}/${volumes.length}（${volumeId}）`);
                const taskRes = await script.fetch(`${window.location.origin}/api/wenku/${target.novelId}/translate-v2/gpt/${encodeURIComponent(volumeId)}`);
                if (!taskRes.ok) throw new Error(`读取卷目录失败（${volumeId}）: HTTP ${taskRes.status}`);
                const task = await taskRes.json();
                const toc = task.toc || [];
                for (let ci = 0; ci < toc.length; ci++) {
                    if (onProgress && toc.length > 1) onProgress(`抓取对照文本：卷 ${vi + 1}/${volumes.length} · 章 ${ci + 1}/${toc.length}`);
                    const chRes = await script.fetch(`${window.location.origin}/api/wenku/${target.novelId}/translate-v2/gpt/${encodeURIComponent(volumeId)}/chapter-task/${toc[ci].chapterId}`);
                    if (!chRes.ok) continue;
                    const dto = await chRes.json();
                    const jp = dto.paragraphJp || [];
                    const zh = Array.isArray(dto.oldParagraphZh) ? dto.oldParagraphZh : [];
                    if (jp.length > 0 && zh.length === 0) translationMissing += 1;
                    chapters += 1;
                    jp.forEach((paragraph, i) => {
                        const translated = typeof zh[i] === 'string' ? zh[i] : '';
                        if (paragraph && translated) pairs.push({
                            jp: paragraph, zh: translated,
                            chapter: toc[ci].title || '', chapterId: toc[ci].chapterId, volumeId,
                        });
                    });
                }
            }
            return { pairs, chapters, translationMissing, chapterMissing: 0, dropped: 0, translator: 'gpt', unmatchedChapters: 0 };
        }
        throw new Error('本地卷暂不支持译文反推：请改用网页/文库目标');
    };

    // 公共：把修句结果写回站点（按章节分组；glossaryId 用章节任务返回的当前值）
    // 站点校验两条：glossaryId 必须等于当前术语表版本（否则 400 术语表失效）、paragraphsZh 长度必须与章节段落数一致
    const writeBackChapterFixes = async (target, translator, rows, onProgress) => {
        const appliedIds = [];
        const failed = [];
        const failedIds = new Set();
        const pushFailed = (id, reason) => {
            if (appliedIds.includes(id) || failedIds.has(id)) return;
            failedIds.add(id);
            failed.push({ id, reason });
        };
        const groups = new Map();
        (rows || []).forEach((row) => {
            const key = target.kind === 'wenku' ? `${row.volumeId || ''}::${row.chapterId || ''}` : String(row.chapterId || '');
            let group = groups.get(key);
            if (!group) {
                group = { chapterId: row.chapterId, volumeId: row.volumeId, chapterTitle: row.chapterTitle, rows: [] };
                groups.set(key, group);
            }
            group.rows.push(row);
        });
        let done = 0;
        for (const group of groups.values()) {
            done += 1;
            if (onProgress) onProgress(`写回章节 ${done}/${groups.size}：${group.chapterTitle || group.chapterId || '?'}`);
            const pendingIds = [];
            try {
                if (!group.chapterId) throw new Error('缺少章节定位（章节标题在 TOC 里找不到）');
                let dto;
                if (target.kind === 'web') {
                    // web 路由的 sync 参数必填（缺了 404）；写回场景原文/译文都已在站点，固定 false
                    const taskRes = await script.fetch(
                        `${window.location.origin}/api/novel/${target.providerId}/${target.novelId}/translate-v2/${translator}/chapter-task/${group.chapterId}?sync=false`,
                        true,
                        { method: 'POST' },
                    );
                    if (!taskRes.ok) throw new Error(`读取章节失败: HTTP ${taskRes.status}`);
                    dto = await taskRes.json();
                } else {
                    const taskRes = await script.fetch(
                        `${window.location.origin}/api/wenku/${target.novelId}/translate-v2/${translator}/${encodeURIComponent(group.volumeId)}/chapter-task/${group.chapterId}`,
                    );
                    if (!taskRes.ok) throw new Error(`读取章节失败: HTTP ${taskRes.status}`);
                    dto = await taskRes.json();
                }
                const paragraphsJp = dto.paragraphJp || [];
                const paragraphsZh = Array.isArray(dto.oldParagraphZh) ? dto.oldParagraphZh.slice() : [];
                if (paragraphsZh.length !== paragraphsJp.length) throw new Error('章节原文与译文段落数不一致，跳过');
                const used = new Set();
                for (const row of group.rows) {
                    const index = GlossaryEngine.locateParagraph(paragraphsJp, row.jp, used);
                    if (index < 0) { pushFailed(row.id, '章节里找不到对应原文'); continue; }
                    used.add(index);
                    if (paragraphsZh[index] === row.after) { appliedIds.push(row.id); continue; }   // 已经是目标文本
                    paragraphsZh[index] = row.after;
                    pendingIds.push(row.id);
                }
                if (pendingIds.length === 0) continue;
                const body = JSON.stringify({ glossaryId: dto.glossaryId, paragraphsZh, sakuraVersion: '0.9' });
                const url = target.kind === 'web'
                    ? `${window.location.origin}/api/novel/${target.providerId}/${target.novelId}/translate-v2/${translator}/chapter/${group.chapterId}`
                    : `${window.location.origin}/api/wenku/${target.novelId}/translate-v2/${translator}/${encodeURIComponent(group.volumeId)}/chapter/${group.chapterId}`;
                const putRes = await script.fetch(url, true, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                });
                if (!putRes.ok) {
                    const detail = await putRes.text().catch(() => '');
                    throw new Error(`上传失败 HTTP ${putRes.status}${detail ? `：${String(detail).slice(0, 120)}` : ''}`);
                }
                appliedIds.push(...pendingIds);
            } catch (e) {
                const reason = (e && e.message) || String(e);
                group.rows.forEach((row) => pushFailed(row.id, reason));
            }
        }
        return { appliedIds, failed };
    };

    // 公共：合并写入（快照 + 合并 + 保存）
    const writeGlossaryMerged = async (target, picked) => {
        const current = await GlossaryTargets.loadGlossary(target);
        const added = picked.filter((row) => !Object.prototype.hasOwnProperty.call(current, row.src)).length;
        GlossaryLog.info('写入术语表', { target: GlossaryTargets.describe(target), picked: picked.length, added, overwrite: picked.length - added });
        await GlossaryTargets.takeSnapshot(target, current, `写入：新增 ${added} / 覆盖 ${picked.length - added}`);
        const merged = Object.assign({}, current);
        picked.forEach((row) => {
            // 指南备注约定：值写为 "译名 #简单标签"（不合格的 info 不写）
            const value = GlossaryEngine.formatGlossaryValue(row.dst, row.type || row.info);
            if (value === '') return;
            const existingValue = current[row.src];
            if (typeof existingValue === 'string') {
                // 译名没变且本次没有新备注 → 保留站点上原有的备注（避免把手工写的 #备注洗掉）
                const oldParts = GlossaryEngine.splitGlossaryValue(existingValue);
                const newParts = GlossaryEngine.splitGlossaryValue(value);
                if (newParts.note === '' && oldParts.note !== '' && oldParts.dst === newParts.dst) {
                    merged[row.src] = `${newParts.dst} #${oldParts.note}`;
                    return;
                }
            }
            merged[row.src] = value;
        });
        const res = await GlossaryTargets.saveGlossary(target, merged);
        if (res && res.refresh) {
            NotificationUtils.showWarning('本地卷术语表已更新：请刷新页面后生效');
        }
        return { before: current, after: merged };
    };


    // 公共：解析术语表条目，返回 [{ src, dst, type, count, context? }]
    // 支持三种来源：KWG 默认 output.json（对象数组）/ 扁平 JSON（output_kv.json 等）/ “原文 => 译文” 行
    const parseGlossaryEntries = (text) => {
        // 去掉 BOM：Windows 记事本等存出来的 UTF-8 文件常带 BOM，否则 startsWith('{') 判断会失效
        const trimmed = (text || '').replace(/^[\uFEFF\uFFFE]+/, '').trim();
        const list = [];
        const push = (src, dst, extra) => {
            if (typeof src !== 'string' || typeof dst !== 'string') return;
            if (src.trim() === '' || dst.trim() === '') return;
            list.push(Object.assign({ src: src.trim(), dst: dst.trim(), type: '', count: 0 }, extra || {}));
        };
        if (!trimmed) return list;
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
            let parsed;
            try {
                parsed = JSON.parse(trimmed);
            } catch (e) {
                NotificationUtils.showError(`JSON 解析失败：${e.message}`);
                return list;
            }
            if (Array.isArray(parsed)) {
                // KWG 默认 output.json：json.dumps([{ 'src': ..., 'dst': ..., 'type': ..., 'count': ... }])
                parsed.forEach((item) => {
                    if (!item || typeof item !== 'object') return;
                    const extra = {};
                    if (typeof item.type === 'string') extra.type = item.type;
                    if (typeof item.count === 'number') extra.count = item.count;
                    if (Array.isArray(item.context)) extra.context = item.context;
                    push(item.src, item.dst, extra);
                });
                return list;
            }
            if (parsed && typeof parsed === 'object') {
                Object.keys(parsed).forEach((k) => push(k, parsed[k]));
                return list;
            }
            return list;
        }
        trimmed.split('\n').forEach((line) => {
            const idx = line.indexOf('=>');
            if (idx < 0) return;
            push(line.slice(0, idx), line.slice(idx + 2));
        });
        return list;
    };

    const parseGlossaryText = (text) => {
        const out = {};
        parseGlossaryEntries(text).forEach((entry) => { out[entry.src] = entry.dst; });
        return out;
    };

    const moduleGlossaryExtract = {
        name: 'AI提取术语表',
        type: 'onclick',
        whitelist: ['/novel', '/wenku', '/favorite', '/workspace'],
        needsTarget: true,
        settings: [
            newSelectSetting('任务方式', ['加入队列', '直接提取'], '加入队列'),
            newSelectSetting('翻译器', workspaceTranslatorOptions, ''),
            newBooleanSetting('使用临时端点', false),
            newStringSetting('临时端点', ''),
            newStringSetting('临时模型', ''),
            newStringSetting('临时Key', ''),
            newSelectSetting('原文语言', ['JA', 'KO', 'ZH'], 'JA'),
            newSelectSetting('模式', ['预览', '写入'], '预览'),
            newNumberSetting('分块字数', 3000),
            newNumberSetting('输出上限', 0),
            newNumberSetting('最大轮数', 3),
            newNumberSetting('并发', 2),
            newNumberSetting('RPM', 0),
            newNumberSetting('逾时(秒)', 300),
            newNumberSetting('行数上限', 0),
            newBooleanSetting('种子补漏', true),
            newNumberSetting('种子轮数', 3),
            newBooleanSetting('证据核实', true),
            newBooleanSetting('调试日志', false),
            newStringSetting('bind', 'none'),
        ],
        // 折叠框：这几个设置收在一起，勾选「使用临时端点」后才可用（勾选时覆盖上面的翻译器下拉）
        settingGroups: [
            { id: 'testEndpoint', title: '临时端点设置（勾选后覆盖上面的翻译器）', members: ['临时端点', '临时模型', '临时Key'], enabledBy: '使用临时端点' },
        ],
        run: async function (cfg) {
            const target = await resolveGlossaryTarget();
            if (!target) return;
            // 默认只把目标排进队列（任务持久化，断了能续跑、失败能重试）；想立刻跑就把「任务方式」切成 直接提取
            if ((getModuleSetting(cfg, '任务方式') || '加入队列') === '加入队列') {
                await GlossaryQueue.addJobs([target], GlossaryQueue.extractSettings());
                NotificationUtils.showSuccess(`已加入队列：${GlossaryTargets.describe(target)}（在「术语队列」里点「开始/续跑」）`);
                return;
            }
            await runGlossaryExtraction(cfg, target);
        },
    };

    const moduleGlossaryImport = {
        name: '导入术语表(KWG)',
        type: 'onclick',
        whitelist: ['/novel', '/wenku', '/favorite', '/workspace'],
        needsTarget: true,
        settings: [
            newTextareaSetting('术语表', ''),
            newBooleanSetting('读取剪贴板', false),
            newBooleanSetting('检查正文', true),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            let text = getModuleSetting(cfg, '术语表') || '';
            if (getModuleSetting(cfg, '读取剪贴板')) {
                try {
                    // readText 在标签页不可见/无焦点时会永久挂起（既不返回也不 reject），必须超时兜底
                    const clip = await Promise.race([
                        navigator.clipboard.readText(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard timeout')), 3000)),
                    ]);
                    if (String(clip || '').trim() !== '') {
                        text = clip;
                    } else {
                        NotificationUtils.showWarning('剪贴板为空，改用设置里的术语表');
                    }
                } catch (e) { NotificationUtils.showWarning('读取剪贴板失败，改用设置里的术语表'); }
            }
            let entries = parseGlossaryEntries(text);
            const count = entries.length;
            const target = await resolveGlossaryTarget();
            if (!target) return;
            // 指南合规检查（导入路径没有提取路径的 count>0 过滤）：
            // 逐条标注「书中未见 / 疑似改原文」，只提示不删，标记进合并弹层的 suspect 体系
            if (count > 0 && getModuleSetting(cfg, '检查正文') !== false && target.kind !== 'local') {
                const progress = GlossaryUI.status(`导入检查 - ${GlossaryTargets.describe(target)}`);
                try {
                    progress.update('抓取正文核对…');
                    const { text: sourceText } = await loadGlossarySourceText(target, (msg) => progress.update(msg));
                    const lines = GlossaryEngine.splitLines(sourceText);
                    const audited = GlossaryEngine.auditImportEntries({ entries, lines });
                    entries = audited.entries;
                    progress.close();
                    const parts = [];
                    if (audited.absent > 0) parts.push(`${audited.absent} 条书中未见`);
                    if (audited.tampered > 0) parts.push(`${audited.tampered} 条疑似改原文`);
                    if (parts.length > 0) NotificationUtils.showWarning(`导入检查：${parts.join(' / ')}（已标记，建议剔除后再写入）`);
                } catch (e) {
                    progress.close();
                    NotificationUtils.showWarning(`正文核对失败（继续导入）：${(e && e.message) || e}`);
                }
            } else if (count > 0 && target.kind === 'local' && getModuleSetting(cfg, '检查正文') !== false) {
                NotificationUtils.showWarning('本地卷不支持正文核对：仅做「疑似改原文」标记');
                entries = entries.map((entry) => GlossaryEngine.looksLikeSourceTampering(entry.src)
                    ? { ...entry, suspect: [...(entry.suspect || []), '疑似改原文'] }
                    : entry);
            }
            const existing = await GlossaryTargets.loadGlossary(target);
            // 文本/剪贴板都没内容时也照常打开弹层：可以在弹层里选 JSON 文件或直接拖进去
            if (count > 0) NotificationUtils.showSuccess(`已解析 ${count} 条术语`);
            else NotificationUtils.showWarning('没有解析到术语：可在弹层里选择 JSON 文件或把文件拖进去');
            GlossaryUI.open({
                title: `导入术语表 - ${target.title || GlossaryTargets.describe(target)}（${count} 条）`,
                target,
                entries,
                existing,
                mode: 'merge',
                enableImport: true,
                onWrite: (picked) => writeGlossaryMerged(target, picked),
            });
        },
    };

    // 同步 Daemon：把站点凭据（auth-v2 token）与工作区 GPT 翻译器配置推给本地 daemon
    // （daemon 用它们调站点 API 与 LLM；token 短时效，这里随时可重新同步）
    // 验收回扫：纯本地计算（不调 LLM、不写站点）——拿术语表 x 原文 x 译文 算落地率
    const moduleAcceptanceScan = {
        name: '验收回扫',
        type: 'onclick',
        whitelist: ['/novel', '/wenku', '/favorite', '/workspace'],
        needsTarget: true,
        settings: [
            // /file 的 translations 参数；文库路径固定 gpt，不受这里影响
            newSelectSetting('译文来源', [...LLM_TRANSLATORS], 'gpt'),
            newNumberSetting('最短译文长度', 2),
            newBooleanSetting('只看未落地', false),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            const target = await resolveGlossaryTarget();
            if (!target) return;
            const translator = normalizeGlossaryTranslator(getModuleSetting(cfg, '译文来源'));
            const minDstLength = Math.max(1, Number(getModuleSetting(cfg, '最短译文长度')) || 2);
            const onlyMissed = getModuleSetting(cfg, '只看未落地') === true;
            const progress = GlossaryUI.status(`验收回扫 - ${GlossaryTargets.describe(target)}`);
            try {
                progress.update('读取术语表…');
                const glossary = await GlossaryTargets.loadGlossary(target);
                const entries = Object.keys(glossary || {}).map((src) => ({ src, dst: glossary[src] }));
                if (entries.length === 0) {
                    progress.close();
                    NotificationUtils.showWarning('该目标术语表为空：先提取/导入术语再回扫');
                    return;
                }
                progress.update('抓取原文与译文…');
                const parallel = await loadGlossaryParallelText(target, translator, (msg) => progress.update(msg));
                progress.update('扫描中…');
                const jpLines = GlossaryEngine.splitLines(parallel.jpText);
                const zhLines = GlossaryEngine.splitLines(parallel.zhText);
                const result = GlossaryEngine.scanAcceptance({ entries, jpLines, zhLines, minDstLength });
                progress.close();
                const stats = result.stats;
                const note = `译文来源 ${parallel.translator || translator}：原文 ${jpLines.length} 行 / 译文 ${zhLines.length} 行`
                    + (stats.checkable === 0 ? '；没有可检条目' : '');
                GlossaryReport.open({
                    title: `验收回扫 - ${target.title || GlossaryTargets.describe(target)}`,
                    rows: result.rows,
                    stats,
                    note,
                    initialFilter: onlyMissed ? 'missed' : 'all',
                });
                NotificationUtils.showSuccess(`回扫完成：落地率 ${(stats.rate * 100).toFixed(1)}%（未落地 ${stats.missed} 条）`);
            } catch (e) {
                progress.close();
                NotificationUtils.showError(`验收回扫失败：${(e && e.message) || e}`);
            }
        },
    };

    // 词根整理：从现有术语表派生"同族词根"建议（纯本地计算），进合并弹层由人逐条确认
    const moduleRootConsolidate = {
        name: '词根整理',
        type: 'onclick',
        whitelist: ['/novel', '/wenku', '/favorite', '/workspace'],
        needsTarget: true,
        settings: [
            newNumberSetting('最少成员数', 2),
            newNumberSetting('建议上限', 40),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            const target = await resolveGlossaryTarget();
            if (!target) return;
            const minMembers = Math.max(2, Number(getModuleSetting(cfg, '最少成员数')) || 2);
            const maxSuggestions = Math.max(1, Number(getModuleSetting(cfg, '建议上限')) || 40);
            const progress = GlossaryUI.status(`词根整理 - ${GlossaryTargets.describe(target)}`);
            try {
                progress.update('读取术语表…');
                const glossary = await GlossaryTargets.loadGlossary(target);
                const entries = Object.keys(glossary || {}).map((src) => ({ src, dst: glossary[src] }));
                if (entries.length < minMembers) {
                    progress.close();
                    NotificationUtils.showWarning('术语条目太少，没有可整理的对象');
                    return;
                }
                progress.update('分析词根候选…');
                const proposals = GlossaryEngine.deriveCommonLiteralRoots(entries, { minMembers }).slice(0, maxSuggestions);
                progress.update('抓取正文核对新增命中…');
                const { text } = await loadGlossarySourceText(target, (msg) => progress.update(msg));
                const lines = GlossaryEngine.splitLines(text);
                // 实体聚类（共现信号）：不产出可写入条目，只做"疑似同实体"提示 + 日志留证；
                // 与词根建议不重复的（无公共前后缀）单独计数
                const clustered = GlossaryEngine.buildEntityClusters({ entries, lines });
                const rootSet = new Set(proposals.map((p) => p.root));
                const aliasGroups = clustered.clusters.filter((c) => !c.root || !rootSet.has(c.root));
                if (aliasGroups.length > 0) {
                    GlossaryLog.info('疑似同实体（共现聚类）', aliasGroups.slice(0, 10).map((c) => ({ members: c.members, sharedLines: c.sharedLines, samples: c.samples })));
                }
                const clusterHint = aliasGroups.length > 0 ? `；另有 ${aliasGroups.length} 组疑似同实体（共现信号，见日志）` : '';
                const suggestions = [];
                let noDst = 0;
                for (const p of proposals) {
                    if (!p.rootDst) { noDst += 1; continue; }   // 推导不出公共译文的不进建议（避免编造）
                    const check = GlossaryEngine.verifyRootCoverage({ root: p.root, members: p.members, lines });
                    suggestions.push({
                        src: p.root,
                        dst: p.rootDst,
                        type: `词根（${p.memberCount} 成员${check.extraCount > 0 ? `，新增命中 ${check.extraCount}` : ''}）`,
                        count: check.rootCount,
                        context: check.extraCount > 0 ? check.extraSamples : [],
                    });
                }
                progress.close();
                if (suggestions.length === 0) {
                    NotificationUtils.showWarning(`没有可推导的词根建议${clusterHint || '（或都被现有条目覆盖）'}`);
                    return;
                }
                GlossaryUI.open({
                    title: `词根整理 - ${target.title || GlossaryTargets.describe(target)}（${suggestions.length} 条建议${noDst ? `，另 ${noDst} 条无公共译文未列` : ''}）`,
                    target,
                    entries: suggestions,
                    existing: glossary,
                    mode: 'merge',
                    onWrite: (picked) => writeGlossaryMerged(target, picked),
                });
                NotificationUtils.showSuccess(`词根整理：${suggestions.length} 条建议（"新增命中">0 的请先看上下文再采纳）${clusterHint}`);
            } catch (e) {
                progress.close();
                NotificationUtils.showError(`词根整理失败：${(e && e.message) || e}`);
            }
        },
    };

    // 译文反推：从 jp-zh 对齐对反推未收录术语的译名建议（纯本地计算），进合并弹层确认
    const moduleGlossaryInfer = {
        name: '译文反推',
        type: 'onclick',
        whitelist: ['/novel', '/wenku', '/favorite', '/workspace'],
        needsTarget: true,
        settings: [
            newSelectSetting('译文来源', [...LLM_TRANSLATORS], 'gpt'),
            newNumberSetting('最少共现次数', 3),
            newNumberSetting('建议上限', 30),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            const target = await resolveGlossaryTarget();
            if (!target) return;
            const translator = normalizeGlossaryTranslator(getModuleSetting(cfg, '译文来源'));
            const minPairs = Math.max(2, Number(getModuleSetting(cfg, '最少共现次数')) || 3);
            const maxSuggestions = Math.max(1, Number(getModuleSetting(cfg, '建议上限')) || 30);
            const progress = GlossaryUI.status(`译文反推 - ${GlossaryTargets.describe(target)}`);
            try {
                progress.update('读取术语表…');
                const glossary = await GlossaryTargets.loadGlossary(target);
                progress.update('抓取对照文本…');
                const aligned = await loadGlossaryAlignedPairs(target, translator, (msg) => progress.update(msg));
                if (aligned.pairs.length === 0) {
                    progress.close();
                    NotificationUtils.showWarning('没有可用的"原文/译文"对齐对：该小说可能还没有译文，或译文来源选错了');
                    return;
                }
                progress.update(`分析共现（${aligned.pairs.length} 对）…`);
                const { suggestions } = GlossaryEngine.inferTranslationsFromPairs({
                    pairs: aligned.pairs,
                    glossary,
                    minPairs,
                    maxSuggestions,
                });
                progress.close();
                if (suggestions.length === 0) {
                    NotificationUtils.showWarning(`没有发现可反推的候选（共 ${aligned.pairs.length} 对，最少共现 ${minPairs} 次）`);
                    return;
                }
                GlossaryUI.open({
                    title: `译文反推 - ${target.title || GlossaryTargets.describe(target)}（${suggestions.length} 条建议 / ${aligned.pairs.length} 对）`,
                    target,
                    entries: suggestions.map((s) => ({
                        src: s.src,
                        dst: s.dst,
                        type: `反推（共现 ${s.support}/${s.pairs}，特异性 ${(s.specificity * 100).toFixed(0)}%）`,
                        count: s.support,
                        context: s.samples,
                    })),
                    existing: glossary,
                    mode: 'merge',
                    onWrite: (picked) => writeGlossaryMerged(target, picked),
                });
                NotificationUtils.showSuccess(`译文反推：${suggestions.length} 条建议（启发式结果，采纳前请核对上下文）`);
            } catch (e) {
                progress.close();
                NotificationUtils.showError(`译文反推失败：${(e && e.message) || e}`);
            }
        },
    };

    // 修句：以未落地清单为输入，LLM 只修术语不一致，审核面板确认后写回站点
    const moduleSentenceFix = {
        name: '修句',
        type: 'onclick',
        whitelist: ['/novel', '/wenku', '/favorite', '/workspace'],
        needsTarget: true,
        settings: [
            newSelectSetting('译文来源', [...LLM_TRANSLATORS], 'gpt'),
            newSelectSetting('翻译器', workspaceTranslatorOptions, ''),
            newBooleanSetting('使用临时端点', false),
            newStringSetting('临时端点', ''),
            newStringSetting('临时模型', ''),
            newStringSetting('临时Key', ''),
            newNumberSetting('每批段落数', 8),
            newNumberSetting('段落上限', 60),
            newNumberSetting('并发', 2),
            newNumberSetting('RPM', 0),
            newNumberSetting('逾时(秒)', 300),
            newNumberSetting('输出上限', 0),
            newStringSetting('bind', 'none'),
        ],
        settingGroups: [
            { id: 'testEndpoint', title: '临时端点设置（勾选后覆盖上面的翻译器）', members: ['临时端点', '临时模型', '临时Key'], enabledBy: '使用临时端点' },
        ],
        run: async function (cfg) {
            const target = await resolveGlossaryTarget();
            if (!target) return;
            const translator = normalizeGlossaryTranslator(getModuleSetting(cfg, '译文来源'));
            const batchSize = Math.max(1, Number(getModuleSetting(cfg, '每批段落数')) || 8);
            const maxParagraphs = Math.max(1, Number(getModuleSetting(cfg, '段落上限')) || 60);
            const concurrency = Math.max(1, Number(getModuleSetting(cfg, '并发')) || 2);
            const rpm = Math.max(0, Number(getModuleSetting(cfg, 'RPM')) || 0);
            const timeoutMs = Math.max(5, Number(getModuleSetting(cfg, '逾时(秒)')) || 300) * 1000;
            const maxTokens = Math.max(0, Number(getModuleSetting(cfg, '输出上限')) || 0);
            const progress = GlossaryUI.status(`修句 - ${GlossaryTargets.describe(target)}`);
            try {
                progress.update('读取术语表…');
                const glossary = await GlossaryTargets.loadGlossary(target);
                if (Object.keys(glossary || {}).length === 0) {
                    progress.close();
                    NotificationUtils.showWarning('术语表为空：先提取/导入术语再修句');
                    return;
                }
                progress.update('抓取对照文本…');
                const aligned = await loadGlossaryAlignedPairs(target, translator, (msg) => progress.update(msg));
                if (aligned.pairs.length === 0) {
                    progress.close();
                    NotificationUtils.showWarning('没有可用的原文/译文对齐对：该小说可能还没有译文，或译文来源选错了');
                    return;
                }
                progress.update('扫描未落地…');
                const planned = GlossaryEngine.planFixTargets({ pairs: aligned.pairs, glossary });
                if (planned.targets.length === 0) {
                    progress.close();
                    NotificationUtils.showSuccess(`未发现未落地术语（${aligned.pairs.length} 对，来源 ${translator}）`);
                    return;
                }
                const rows = GlossaryEngine.buildFixRows(planned.targets, { maxParagraphs });
                const workers = await resolveGlossaryWorkers(cfg);
                if (workers.length === 0) {
                    progress.close();
                    NotificationUtils.showError('没有可用的翻译器：请在工作区添加 GPT 翻译器，或勾选「使用临时端点」并填好端点/模型');
                    return;
                }
                const requester = GlossaryEngine.createRequester(workers, { timeoutMs, rps: concurrency, rpm, maxTokens });
                const batches = [];
                for (let i = 0; i < rows.length; i += batchSize) {
                    batches.push(rows.slice(i, i + batchSize).map((row, k) => ({ row, globalId: i + k })));
                }
                let cursor = 0;
                let doneBatches = 0;
                let parseInvalid = 0;
                let requestFailed = 0;
                const fixes = new Map(); // globalId -> after
                const lane = async () => {
                    for (;;) {
                        const myIndex = cursor;
                        cursor += 1;
                        if (myIndex >= batches.length) return;
                        const batch = batches[myIndex];
                        const prompt = GlossaryEngine.buildFixPrompt({ rows: batch.map((b) => b.row) });
                        let result;
                        try {
                            result = await requester.call([{ role: 'user', content: prompt }]);
                        } catch (e) {
                            result = { ok: false, error: String((e && e.message) || e) };
                        }
                        if (result && result.ok && String(result.content || '').trim() !== '') {
                            const parsed = GlossaryEngine.parseFixResponse(result.content, { rowCount: batch.length });
                            parseInvalid += parsed.invalid;
                            for (const [localId, text] of parsed.fixes) {
                                const entry = batch[localId];
                                if (entry) fixes.set(entry.globalId, text);
                            }
                        } else {
                            requestFailed += 1;
                        }
                        doneBatches += 1;
                        progress.update(`修句请求 ${doneBatches}/${batches.length} 批（已生成 ${fixes.size} 条修正）`, doneBatches / batches.length);
                    }
                };
                await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, () => lane()));
                progress.close();

                const panelRows = rows.map((row, index) => {
                    const pair = aligned.pairs[row.pairIndex] || {};
                    const after = fixes.get(index);
                    return {
                        id: index,
                        chapterKey: pair.chapterId || pair.chapter || '',
                        chapterId: pair.chapterId,
                        volumeId: pair.volumeId,
                        chapterTitle: pair.chapter || '',
                        jp: row.jp,
                        zh: row.zh,
                        missed: row.missed,
                        after: after || '',
                        status: after ? 'changed' : 'unchanged',
                    };
                });
                const changed = panelRows.filter((r) => r.status === 'changed').length;
                GlossaryFix.open({
                    title: `修句 - ${target.title || GlossaryTargets.describe(target)}（${changed} 段可写回 / 共 ${panelRows.length} 段）`,
                    note: `译文来源 ${translator}：修句只改术语不一致；写回会直接更新站点译文。请求失败 ${requestFailed} 批${parseInvalid ? `，格式异常 ${parseInvalid} 条` : ''}`,
                    rows: panelRows,
                    onApply: (ids, onApplyProgress) => writeBackChapterFixes(
                        target,
                        translator,
                        panelRows.filter((r) => ids.includes(r.id)),
                        onApplyProgress,
                    ),
                });
            } catch (e) {
                progress.close();
                NotificationUtils.showError(`修句失败：${(e && e.message) || e}`);
            }
        },
    };

    // ---- Daemon 连接：探测 /ping → 推送 /auth；状态写入「连接状态」只读行 + 行尾角标 ----
    const daemonProbe = async (base) => {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 3000);
        try {
            const res = await fetch(`${base}/ping`, { signal: ctrl.signal });
            if (!res.ok) return null;
            return await res.json();
        } catch (e) { return null; } finally { clearTimeout(timer); }
    };
    const daemonSetStatus = (cfg, text) => {
        const s = ((cfg && cfg.settings) || []).find((x) => x && x.name === '连接状态');
        if (s) s.value = text;
        const el = document.querySelector('[data-role="daemon-status"]');
        if (el) el.textContent = text;
    };
    const DAEMON_FP_KEY = 'ntr-daemon-auth-fp';
    const daemonReadToken = () => {
        // 优先复用工具箱的 initToken 回落链（auth-v2 → auth.profile），再兜底直读
        try {
            const box = window._NTRToolBox;
            if (box && typeof box.initToken === 'function') {
                const t = box.initToken();
                if (t) return t;
            }
        } catch (e) { }
        try { return (JSON.parse(localStorage.getItem('auth-v2')) || {}).token || ''; } catch (e) { return ''; }
    };
    const daemonFingerprint = (token, workers) => JSON.stringify({ token, workers, origin: window.location.origin });
    // 共用推送：manual（手动点）/ auto（30s tick 自动）同一条路径；silent 时不弹成功/失败通知
    const daemonPushCredentials = async (cfg, { silent = false, auto = false } = {}) => {
        const base = (getModuleSetting(cfg, 'Daemon 地址') || '').trim().replace(/\/$/, '');
        const lnaHintOf = (e) => (e instanceof TypeError && window.location.protocol === 'https:')
            ? '；HTTPS 页面若被浏览器拦（Failed to fetch），在地址栏允许本站的本地网络访问权限'
            : '';
        if (!base) {
            daemonSetStatus(cfg, '未配置');
            if (!silent) NotificationUtils.showError('未配置 Daemon 地址（如 http://127.0.0.1:7331）');
            return { ok: false, error: 'no_base' };
        }
        const ping = await daemonProbe(base);
        if (!ping || !ping.ok) {
            daemonSetStatus(cfg, '离线');
            if (window._NTRToolBox && typeof window._NTRToolBox.refreshDaemonGlance === 'function') window._NTRToolBox.refreshDaemonGlance(true);
            if (!silent) NotificationUtils.showError(`daemon 不可达（${base}）：是否在跑？node daemon/index.mjs serve${lnaHintOf(new TypeError())}`);
            return { ok: false, error: 'offline' };
        }
        const token = daemonReadToken();
        if (!token) {
            daemonSetStatus(cfg, `在线 ${ping.version || ''} · 未同步（读不到站内凭据，请先登录）`);
            if (!silent) NotificationUtils.showError('读不到站点凭据（auth-v2 / auth）：请先在站点登录');
            return { ok: false, error: 'no_token' };
        }
        const workers = readWorkspaceGptWorkers();
        try {
            const res = await fetch(`${base}/auth`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token, workers, origin: window.location.origin, auto: !!auto }),
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const fp = daemonFingerprint(token, workers);
            try { localStorage.setItem(DAEMON_FP_KEY, fp); } catch (e) { }
            daemonSetStatus(cfg, `在线 ${ping.version || ''} · 已同步 ${new Date().toLocaleString()}`);
            if (!silent) NotificationUtils.showSuccess(`已同步到 Daemon（${ping.version || 'daemon'}）：凭据 + ${workers.length} 个翻译器`);
            return { ok: true, version: ping.version || '', workers: workers.length, fingerprint: fp };
        } catch (e) {
            if (!silent) NotificationUtils.showError(`同步失败：${(e && e.message) || e}（daemon 是否在跑？node daemon/index.mjs serve${lnaHintOf(e)}）`);
            return { ok: false, error: String((e && e.message) || e) };
        }
    };

    const moduleDaemonSync = {
        name: 'Daemon 连接',
        type: 'onclick',
        whitelist: ['/novel', '/wenku', '/favorite', '/workspace'],
        settings: [
            newStringSetting('Daemon 地址', 'http://127.0.0.1:7331'),
            newBooleanSetting('自动同步', true),
            { name: '连接状态', type: 'status', value: '未探测' },
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            await daemonPushCredentials(cfg, { silent: false, auto: false });
        },
    };

    const moduleGlossaryRollback = {
        name: '回滚术语表',
        type: 'onclick',
        whitelist: ['/novel', '/wenku', '/favorite', '/workspace'],
        needsTarget: true,
        settings: [
            newBooleanSetting('确认', true),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            const target = await resolveGlossaryTarget();
            if (!target) return;
            const versions = await GlossaryTargets.listSnapshots(target);
            if (versions.length === 0) {
                NotificationUtils.showWarning('没有找到该目标的快照（写入术语表时会自动生成）');
                return;
            }
            const current = await GlossaryTargets.loadGlossary(target);
            const countOf = (glossary) => Object.keys(glossary || {}).length;
            const picked = await GlossaryUI.pick({
                title: `回滚术语表 - ${target.title || GlossaryTargets.describe(target)}（共 ${versions.length} 个版本）`,
                options: versions,
                renderOption: (v) => {
                    const g = v.glossary || {};
                    let add = 0; let update = 0; let remove = 0;
                    Object.keys(g).forEach((src) => {
                        if (!Object.prototype.hasOwnProperty.call(current, src)) add += 1;
                        else if (current[src] !== g[src]) update += 1;
                    });
                    Object.keys(current).forEach((src) => { if (!Object.prototype.hasOwnProperty.call(g, src)) remove += 1; });
                    const time = new Date(v.createAt).toLocaleString();
                    return `${time} | ${countOf(g)} 条 | 相对当前：新增 ${add} / 覆盖 ${update} / 删除 ${remove}${v.note ? ' | ' + v.note : ''}`;
                },
            });
            if (!picked) return;
            const snapGlossary = picked.glossary || {};
            const entries = Object.keys(snapGlossary).map((src) => ({ src, dst: snapGlossary[src], type: '', count: 0 }));
            const timeHint = new Date(picked.createAt).toLocaleString();
            GlossaryUI.open({
                title: `回滚预览 - ${timeHint} 的版本（${entries.length} 条）`,
                target,
                entries,
                existing: current,
                mode: 'restore',
                confirmRestore: !!getModuleSetting(cfg, '确认'),
                onRestore: async () => {
                    await GlossaryTargets.takeSnapshot(target, current, '回滚前自动快照');
                    const res = await GlossaryTargets.saveGlossary(target, snapGlossary);
                    if (res && res.refresh) NotificationUtils.showWarning('本地卷术语表已更新：请刷新页面后生效');
                    NotificationUtils.showSuccess(`已回滚到 ${timeHint} 的版本（${entries.length} 条）`);
                },
            });
        },
    };

    const moduleGlossaryQueue = {
        name: '术语队列',
        type: 'onclick',
        whitelist: ['/novel', '/wenku', '/favorite', '/workspace'],
        settings: [
            newBooleanSetting('自动续跑', true),
            newBooleanSetting('自动确认纯新增', false),
            newNumberSetting('保留已完成', 5),
            newNumberSetting('收藏添加上限', 30),
            // 队列任务的运行类覆盖：填了值就覆盖「AI提取术语表」的同名设置，0 = 跟随
            newNumberSetting('并发(0=跟随)', 0),
            newNumberSetting('RPM(0=跟随)', 0),
            newNumberSetting('逾时(秒,0=跟随)', 0),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            GlossaryQueue.openPanel();
        },
    };

    // 站点新版「GPT工作区BETA」(/workspace/gpt-pipeline) 用的是另一个存储键 workspace-gpt-pipeline，
    // 翻译器不会自动搬过去 —— 这个模块就是把老工作区的 GPT 翻译器一键复制过去（任务队列不搬）
    const moduleCopyWorkersToBeta = {
        name: '复制翻译器到BETA工作区',
        type: 'onclick',
        whitelist: ['/workspace', '/novel', '/wenku', '/favorite'],
        settings: [
            newBooleanSetting('覆盖同名翻译器', false),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            const overwrite = getModuleSetting(cfg, '覆盖同名翻译器') === true;
            const readStore = (key) => {
                try {
                    const raw = localStorage.getItem(key);
                    return raw ? (JSON.parse(raw) || {}) : {};
                } catch (e) { return {}; }
            };
            const BETA_KEY = 'workspace-gpt-pipeline';
            // 'web' 类型是老工作区里被站点自己淘汰的（chat.openai.com 那套），不搬
            const src = (readStore('workspace-gpt').workers || []).filter((w) => w && w.id && w.endpoint && w.type !== 'web');
            if (src.length === 0) {
                NotificationUtils.showWarning('老「GPT工作区」里没有可复制的翻译器');
                return;
            }
            const betaRaw = readStore(BETA_KEY);
            const beta = {
                workers: Array.isArray(betaRaw.workers) ? betaRaw.workers : [],
                jobs: Array.isArray(betaRaw.jobs) ? betaRaw.jobs : [],
                uncompletedJobs: Array.isArray(betaRaw.uncompletedJobs) ? betaRaw.uncompletedJobs : [],
            };
            let added = 0, updated = 0, skipped = 0;
            src.forEach((w) => {
                const i = beta.workers.findIndex((x) => x && x.id === w.id);
                if (i < 0) { beta.workers.push(Object.assign({}, w)); added++; }
                else if (overwrite) { beta.workers[i] = Object.assign({}, w); updated++; }
                else skipped++;
            });
            if (added + updated === 0) {
                NotificationUtils.showWarning(`BETA 工作区里已有同名翻译器（${skipped} 个），勾选「覆盖同名翻译器」可更新`);
                return;
            }
            const text = JSON.stringify(beta);
            localStorage.setItem(BETA_KEY, text);
            // 通知页面上已经打开的 BETA 工作区（VueUse 的 useLocalStorage 监听 storage 事件），避免它下一次保存把我们的写入顶掉
            window.dispatchEvent(new StorageEvent('storage', { key: BETA_KEY, newValue: text, url: location.href, storageArea: localStorage }));
            NotificationUtils.showSuccess(`已复制 ${added} 个翻译器到 BETA 工作区${updated ? `，更新 ${updated} 个` : ''}${skipped ? `，跳过同名 ${skipped} 个` : ''}`);
        },
    };

    // 把老工作区 workspace-gpt 与「GPT工作区BETA」workspace-gpt-pipeline 的翻译器当成同一份配置（按 id 映射），
    // 三路合并后写回两边：base = 上次同步的结果（存在我们自己的 ntr-workspace-sync，站点键不碰）。
    //   · 只在一边出现的翻译器 → 复制到另一边
    //   · 上次同步后从一边消失的 → 另一边也删掉（删除能生效，不会"复活"）
    //   · 同一条的某个字段两边都改了 → 按「当前所在的工作区」取值（不在工作区页面时按老工作区）
    // 任务队列（jobs/uncompletedJobs）各自保留不动；老式 type:'web' 翻译器不参与（站点自己已淘汰）。
    const WORKSPACE_SYNC_STATE = 'ntr-workspace-sync';
    const WORKSPACE_PAIR = { legacy: 'workspace-gpt', beta: 'workspace-gpt-pipeline' };

    const readWorkspaceStoreFull = (key) => {
        let obj = {};
        try {
            const raw = localStorage.getItem(key);
            obj = raw ? (JSON.parse(raw) || {}) : {};
        } catch (e) { obj = {}; }
        return {
            workers: Array.isArray(obj.workers) ? obj.workers : [],
            jobs: Array.isArray(obj.jobs) ? obj.jobs : [],
            uncompletedJobs: Array.isArray(obj.uncompletedJobs) ? obj.uncompletedJobs : [],
        };
    };
    const syncableWorker = (w) => !!w && !!w.id && w.type !== 'web';
    const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    const workerSig = (w) => JSON.stringify([w.endpoint, w.model, w.key]);

    const mergeWorkerFields = (a, b, baseW, preferSide) => {
        const out = {};
        const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {}), ...Object.keys(baseW || {})]);
        keys.forEach((k) => {
            const av = a ? a[k] : undefined;
            const bv = b ? b[k] : undefined;
            const baseV = baseW ? baseW[k] : undefined;
            if (sameJson(av, bv)) { if (av !== undefined) out[k] = av; return; }
            if (sameJson(av, baseV)) { if (bv !== undefined) out[k] = bv; return; }   // 只有 BETA 改过
            if (sameJson(bv, baseV)) { if (av !== undefined) out[k] = av; return; }   // 只有老工作区改过
            const pick = preferSide === 'beta' ? bv : av;
            if (pick !== undefined) out[k] = pick;
        });
        return out;
    };

    const currentWorkspaceSide = () => {
        if (location.pathname.includes('/workspace/gpt-pipeline')) return 'beta';
        if (location.pathname.includes('/workspace/gpt')) return 'legacy';
        return null;
    };

    const syncWorkspaceTranslators = (preferSide) => {
        const L = readWorkspaceStoreFull(WORKSPACE_PAIR.legacy);
        const B = readWorkspaceStoreFull(WORKSPACE_PAIR.beta);
        let base = {};
        let hasBase = false;
        try {
            const raw = localStorage.getItem(WORKSPACE_SYNC_STATE);
            if (raw) { base = (JSON.parse(raw) || {}).workers || {}; hasBase = true; }
        } catch (e) { base = {}; }

        const toMap = (workers) => {
            const m = new Map();
            workers.filter(syncableWorker).forEach((w) => m.set(String(w.id), w));
            return m;
        };
        const lMap = toMap(L.workers);
        const bMap = toMap(B.workers);

        // 内容一样但 id 不同（老工作区用自定义名字、BETA 弹窗拿模型名当 id）→ 视为同一条，统一用老工作区的 id
        const bTwin = new Map();
        bMap.forEach((w, id) => { const s = workerSig(w); if (!bTwin.has(s)) bTwin.set(s, id); });
        lMap.forEach((w, id) => {
            if (bMap.has(id)) return;
            const twin = bTwin.get(workerSig(w));
            if (twin && !lMap.has(twin)) {
                bMap.set(id, bMap.get(twin));
                bMap.delete(twin);
                bTwin.delete(workerSig(w));
            }
        });

        const beforeIds = new Set([...lMap.keys(), ...bMap.keys()]);
        const merged = new Map();
        let added = 0, updated = 0, removed = 0;
        [...new Set([...beforeIds, ...Object.keys(base)])].forEach((id) => {
            const a = lMap.get(id), b = bMap.get(id);
            const baseW = base[id];
            if (baseW && !a && !b) { removed++; return; }        // 两边都删了
            if (baseW && a && !b) { removed++; return; }         // BETA 删了 → 老工作区跟着删（删除优先）
            if (baseW && !a && b) { removed++; return; }         // 老工作区删了 → BETA 跟着删
            if (!a && !b) return;
            if (!baseW && a && !b) { merged.set(id, Object.assign({}, a, { id })); added++; return; }
            if (!baseW && !a && b) { merged.set(id, Object.assign({}, b, { id })); added++; return; }
            const m = mergeWorkerFields(a, b, baseW || {}, preferSide);
            m.id = id;
            if (!sameJson(m, a) || !sameJson(m, b)) updated++;
            merged.set(id, m);
        });

        const orderedIds = [];
        const seenId = new Set();
        [lMap, bMap].forEach((map) => map.forEach((_, id) => {
            if (!merged.has(id) || seenId.has(id)) return;
            seenId.add(id);
            orderedIds.push(id);
        }));
        const mergedWorkers = orderedIds.map((id) => merged.get(id));

        // 不参与同步的条目（web 类型等）原样留在各自存储里
        let wrote = 0;
        const apply = (key, store, keepTail) => {
            const next = mergedWorkers.concat(keepTail);
            if (sameJson(store.workers, next)) return;
            const text = JSON.stringify({ workers: next, jobs: store.jobs, uncompletedJobs: store.uncompletedJobs });
            localStorage.setItem(key, text);
            // 让页面上已打开的工作区（VueUse 的 useLocalStorage 监听 storage）同步，避免它下次保存把写入顶掉
            window.dispatchEvent(new StorageEvent('storage', { key, newValue: text, url: location.href, storageArea: localStorage }));
            wrote++;
        };
        apply(WORKSPACE_PAIR.legacy, L, L.workers.filter((w) => !syncableWorker(w)));
        apply(WORKSPACE_PAIR.beta, B, B.workers.filter((w) => !syncableWorker(w)));

        if (added + updated + removed > 0 || !hasBase) {
            localStorage.setItem(WORKSPACE_SYNC_STATE, JSON.stringify({ at: Date.now(), workers: Object.fromEntries(merged) }));
        }
        return { added, updated, removed, wrote, total: mergedWorkers.length };
    };

    // 离开任一工作区页面后仍在跑（keep 模块在被启动后跨页面持续轮询），所以"切出时同步"是靠下一次轮询落地的
    const moduleWorkspaceSync = {
        name: '工作区翻译器自动同步',
        type: 'keep',
        whitelist: ['/novel', '/wenku', '/favorite', '/workspace'],
        settings: [
            newBooleanSetting('自动同步', true),
            newStringSetting('bind', 'none'),
        ],
        _lastRun: 0,
        _interval: 3000,
        _wasActive: false,
        run: async function (cfg) {
            if (getModuleSetting(cfg, '自动同步') === false) return;
            const now = Date.now();
            if (!this._wasActive) {
                this._wasActive = true;
                NotificationUtils.showSuccess('工作区翻译器自动同步已开启（老工作区 ⇄ BETA 工作区）');
            }
            if (now - this._lastRun < this._interval) return;
            this._lastRun = now;
            try {
                const r = syncWorkspaceTranslators(currentWorkspaceSide());
                if (r.added + r.updated + r.removed > 0) {
                    NotificationUtils.showSuccess(`工作区翻译器已同步：新增 ${r.added} · 更新 ${r.updated} · 删除 ${r.removed}`);
                }
            } catch (e) {
                console.error('工作区翻译器自动同步失败', e);
            }
        },
    };

    const defaultModules = [
        moduleAddSakuraTranslator,
        moduleAddGPTTranslator,
        moduleDeleteTranslator,
        moduleLaunchTranslator,
        moduleQueueSakuraV2,
        moduleQueueGPTV2,
        moduleAutoRetry,
        moduleClearJobs,
        moduleFillGlossary,
        moduleGlossaryExtract,
        moduleGlossaryImport,
        moduleAcceptanceScan,
        moduleRootConsolidate,
        moduleGlossaryInfer,
        moduleSentenceFix,
        moduleGlossaryRollback,
        moduleGlossaryQueue,
        moduleCopyWorkersToBeta,
        moduleDaemonSync,
        moduleWorkspaceSync,
        moduleSyncStorage,
    ];

    // -----------------------------------
    // Setting Utils
    // -----------------------------------
    class SettingUtils {
        // 「模式」设置值 → 任务串里的 level= 档位（linkBuilder 的 mode 参数）
        static getTranslateMode(mode) {
            const levels = [['常规', 'normal'], ['过期', 'expire'], ['重翻', 'all']];
            const hit = levels.find(([label]) => label === mode);
            return hit ? hit[1] : undefined;
        }
    }

    // -----------------------------------
    // TaskUtils Utils（clean-room 重写，契约：docs/cleanroom/spec-02-helper-layer.md §4）
    // -----------------------------------
    class TaskUtils {
        // 页型判定：顺序敏感 —— 列表页（无子路径）必须排在详情页之前
        static getTypeString(url) {
            const pages = [
                ['wenkus', /^\/wenku(\?.*)?$/],
                ['wenku', /^\/wenku\/.*(\?.*)?$/],
                ['novels', /^\/novel(\?.*)?$/],
                ['novel', /^\/novel\/.*(\?.*)?$/],
                ['favorite-web', /^\/favorite\/web(\/.*)?(\?.*)?$/],
                ['favorite-wenku', /^\/favorite\/wenku(\/.*)?(\?.*)?$/],
                ['favorite-local', /^\/favorite\/local(\/.*)?(\?.*)?$/],
            ];
            const hit = pages.find(([, re]) => re.test(url));
            return hit ? hit[0] : null;
        }

        // 任务串 = 目标路径 + 档位 + 章节区间；格式是站点接口契约，一字不差
        static wenkuLinkBuilder(series, volume, mode) {
            return `wenku/${series}/${volume}?level=${mode}&forceMetadata=false&startIndex=0&endIndex=65536`;
        }

        static webLinkBuilder(path, from = 0, to = 65536, mode) {
            return `web${path}?level=${mode}&forceMetadata=false&startIndex=${from}&endIndex=${to}`;
        }

        static wenkuIds() {
            return [...document.querySelectorAll('a[href^="/wenku/"]')]
                .map((a) => a.getAttribute('href').split('/wenku/')[1]);
        }

        // 搜索接口 URL：筛选条件来自列表页 URL 参数（selected 依次为 站点位掩码/类型/分级/翻译/排序）
        static webSearchApi(limit = 20) {
            const params = new URLSearchParams(location.search);
            const page = Math.max(parseInt(params.get('page')) - 1 || 0, 0);
            const query = params.get('query') || '';
            const picked = params.getAll('selected').map(Number);
            const providerVal = picked[0] ?? 0xff;
            const typeVal = picked[1] ?? 0;
            const levelVal = picked[2] ?? 0;
            const translateVal = picked[3] ?? 0;
            const sortVal = picked[4] ?? 0;

            const providerBits = { kakuyomu: 1, syosetu: 2, novelup: 4, hameln: 8, pixiv: 16, alphapolis: 32 };
            const allProviders = Object.keys(providerBits).join(',');
            let providers = Object.keys(providerBits)
                .filter((name) => providerVal & providerBits[name])
                .join(',');
            if (providerVal === 0xff || !providers) {
                providers = allProviders;
            }

            return `/api/novel?page=${page}&pageSize=${limit}&query=${encodeURIComponent(query)}`
                + `&provider=${encodeURIComponent(providers)}&type=${typeVal}&level=${levelVal}`
                + `&translate=${translateVal}&sort=${sortVal}`;
        }

        // 每本还差多少章：normal 档按站点进度扣减（可钳到 0），其余档全量
        static _chaptersLeft(novel, mode, clipAtZero) {
            if (mode !== 'normal') return novel.total;
            const done = (novel.sakura ?? novel.gpt) || 0;
            const left = novel.total - done;
            return clipAtZero ? Math.max(left, 0) : left;
        }

        // 智能分段：全库按缺口降序凑任务，块大小 = ⌈总缺口/任务数⌉，凑满 jobLimit 为止
        static async assignTasksSmart(novels, jobLimit, chapterLimit, mode) {
            const left = (n) => TaskUtils._chaptersLeft(n, mode, true);
            const totalLeft = novels.reduce((sum, n) => sum + left(n), 0);
            if (totalLeft === 0) {
                return [];
            }
            let taskCount = Math.min(Math.floor(totalLeft / chapterLimit), jobLimit);
            if (taskCount <= 0) {
                taskCount = jobLimit;
            }
            const chunkSize = Math.ceil(totalLeft / (taskCount || 1));

            const result = [];
            let used = 0;
            for (const novel of [...novels].sort((a, b) => left(b) - left(a))) {
                let remain = left(novel);
                let start = (mode === 'normal') ? (novel.total - remain) : 0;
                while (remain > 0 && used < jobLimit) {
                    const size = Math.min(remain, chunkSize);
                    result.push({
                        task: TaskUtils.webLinkBuilder(novel.url, start, start + size, mode),
                        description: novel.description,
                    });
                    used++;
                    remain -= size;
                    start += size;
                }
                if (used >= jobLimit) {
                    break;
                }
            }
            return result;
        }

        // 固定分段：每本固定切 parts 块，末块吞余数；缺口 ≤0 的整本跳过
        static async assignTasksStatic(novels, parts, mode) {
            const result = [];
            for (const novel of novels) {
                const totalLeft = TaskUtils._chaptersLeft(novel, mode, false);
                if (totalLeft <= 0) continue;
                const startBase = (mode === 'normal') ? (novel.total - totalLeft) : 0;
                const chunkSize = Math.ceil(totalLeft / parts);
                for (let i = 0; i < parts; i++) {
                    const chunkStart = startBase + i * chunkSize;
                    if (chunkStart >= startBase + totalLeft) continue;
                    const chunkEnd = (i === parts - 1) ? (startBase + totalLeft) : (chunkStart + chunkSize);
                    result.push({
                        task: TaskUtils.webLinkBuilder(novel.url, chunkStart, chunkEnd, mode),
                        description: novel.description,
                    });
                }
            }
            return result;
        }

        // 置顶按钮：reserve 时从最后一个 extra 往前数
        static async clickTaskMoveToTop(count, reserve = true) {
            const extras = document.querySelectorAll('.n-thing-header__extra');
            for (let i = 0; i < count; i++) {
                const container = extras[reserve ? (extras.length - i - 1) : i];
                const button = container && container.querySelectorAll('button')[0];
                if (button) {
                    button.click();
                }
            }
        }

        static async clickButtons(name = '') {
            [...document.querySelectorAll('button')].forEach((btn) => {
                if (name === '' || btn.textContent.includes(name)) {
                    btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                }
            });
        }
    }

    // -----------------------------------
    // Glossary Engine (移植 KeywordGacha module/{Text,PromptBuilder,Response,Filter,Engine})
    // -----------------------------------
    // ==GlossaryEngine-START==
    // -----------------------------------
    // 调试日志（可选）：Console 输出 + 内存环形缓冲 + 导出文本
    // - WARN/ERROR 永远记（最近 200 条，也永远打 Console，和以前 chunk failed 的行为一致）
    // - 开了设置项「调试日志」后 INFO/DEBUG 也记（最近 1000 条）并打 Console
    // - 「开没开」由外面注入的读取器决定；引擎段单独在 node 里跑测试时没有读取器 = 关闭
    // -----------------------------------
    const GlossaryLog = (() => {
        const MAX_ALL = 1000;
        const MAX_ERR = 200;
        const all = [];
        const errs = [];
        let reader = null;
        const pad = (n, w = 2) => String(n).padStart(w, '0');
        const stamp = (t) => {
            const d = new Date(t);
            return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
        };
        const enabled = () => {
            if (!reader) return false;
            try { return !!reader(); } catch (e) { return false; }
        };
        const setEnabledSource = (fn) => { if (typeof fn === 'function') reader = fn; };
        const line = (rec) => `[NTA-G] ${stamp(rec.t)} ${rec.level.toUpperCase()} ${rec.msg}${rec.data ? ' ' + JSON.stringify(rec.data) : ''}`;
        const push = (level, msg, data) => {
            const rec = { t: Date.now(), level, msg: String(msg) };
            if (data !== undefined) {
                try { rec.data = JSON.parse(JSON.stringify(data)); } catch (e) { rec.data = String(data); }
            }
            if (level === 'warn' || level === 'error') {
                errs.push(rec);
                if (errs.length > MAX_ERR) errs.shift();
                try { (level === 'error' ? console.error : console.warn).call(console, line(rec)); } catch (e) { }
            }
            if (!enabled()) return rec;
            all.push(rec);
            if (all.length > MAX_ALL) all.shift();
            if (level === 'info' || level === 'debug') {
                try { console.log(line(rec)); } catch (e) { }
            }
            return rec;
        };
        return {
            setEnabledSource,
            enabled,
            info: (msg, data) => push('info', msg, data),
            debug: (msg, data) => push('debug', msg, data),
            warn: (msg, data) => push('warn', msg, data),
            error: (msg, data) => push('error', msg, data),
            // 导出：开着 → 全部事件；没开（或开了还没产生事件）→ 只有警告/错误，也够定位问题了
            lines: () => (enabled() && all.length > 0 ? all : errs),
            format: () => (enabled() && all.length > 0 ? all : errs).map(line).join('\n'),
            clear: () => { all.length = 0; errs.length = 0; },
            stats: () => ({ enabled: enabled(), kept: (enabled() && all.length > 0 ? all : errs).length, errors: errs.length }),
        };
    })();

    // ---------- 站点自检：脚本依赖的「站点挂点」是否发生变动 ----------
    // 脚本很多功能挂在站点的固定位置上（面板、会话存储、工作区翻译器存储、本地卷库、
    // 列表页条目/分页、工作区任务条目）。站点改版时这些位置可能移动/改名，功能就会
    // 静默失灵。启动后自动跑一遍（SPA 路由切换也会重跑）：结果进日志；确有变动时
    // 面板信息栏常驻「⚠ 自检 N」，并弹一次提示。
    const SiteCheck = (() => {
        let scriptRef = null;
        let results = [];
        let lastSummary = null;
        let lastPath = null;
        let timer = null;
        let running = false;
        let rerun = false;
        let epoch = 0;   // 新一轮检查开始 / cancel 时 +1，作废还在等待 DOM 的旧一轮

        const isSite = () => domainAllowed;
        // 和「填充术语表」collectNovels 同款判定：站内 /novel/{provider}/{id} 链接（相对/绝对 href 都算）
        const listLinks = () => [...document.querySelectorAll('a')].filter((a) => {
            try {
                const u = new URL(a.href);
                return u.origin === location.origin && /^\/novel\/[^/]+\/[^/]+$/.test(u.pathname);
            } catch (e) { return false; }
        }).length;
        const waitFor = async (fn, ms, my) => {
            const t0 = Date.now();
            while (!fn() && Date.now() - t0 < ms) {
                if (epoch !== my) return fn();
                await new Promise((r) => setTimeout(r, 400));
            }
            return fn();
        };
        const findVisiblePagination = () => [...document.querySelectorAll('.n-pagination')].find((p) => p.offsetWidth || p.offsetHeight) || null;

        const CHECKS = [
            {
                id: 'panel', name: '面板挂载点',
                run: () => (scriptRef && scriptRef.panel && document.body.contains(scriptRef.panel))
                    ? { status: 'ok', detail: '#ntr-panel 挂在 body 上' }
                    : { status: 'warn', detail: '找不到 #ntr-panel（面板没挂上或被移除）' },
            },
            {
                id: 'auth', name: '会话存储（auth-v2）', site: true,
                run: () => (scriptRef && scriptRef.initToken && scriptRef.initToken())
                    ? { status: 'ok', detail: '已读到会话 token' }
                    : { status: 'warn', detail: '读不到 auth-v2 / auth 里的 token：未登录，或站点会话存储键已变动（接口会 401）' },
            },
            {
                id: 'workspace-gpt', name: '工作区翻译器存储', site: true,
                run: () => {
                    const ws = readWorkspaceGptWorkers() || [];
                    return ws.length
                        ? { status: 'ok', detail: `${ws.length} 个：${ws.map((w) => w.id).slice(0, 4).join('、')}${ws.length > 4 ? '…' : ''}` }
                        : { status: 'info', detail: '没有找到工作区翻译器（workspace-gpt / workspace-gpt-pipeline 都空）：术语表需要用「临时端点」' };
                },
            },
            {
                id: 'volumes-idb', name: '本地卷数据库（IndexedDB volumes）', site: true,
                run: async () => {
                    if (!indexedDB.databases) return { status: 'info', detail: '浏览器不支持 indexedDB.databases()，跳过' };
                    try {
                        const dbs = await indexedDB.databases();
                        return dbs.some((d) => d.name === 'volumes')
                            ? { status: 'ok', detail: 'volumes 库存在' }
                            : { status: 'info', detail: '还没有 volumes 库（用过「本地卷」功能后才创建）' };
                    } catch (e) { return { status: 'info', detail: '查询失败：' + e.message }; }
                },
            },
            {
                id: 'list-items', name: '列表页条目容器', path: (p) => p === '/novel',
                run: async (ctx) => {
                    await ctx.wait(() => listLinks() > 0 || !!findVisiblePagination());
                    const links = listLinks();
                    if (links === 0) return { status: 'info', detail: '本页没有小说条目链接（空结果，或还没加载完）' };
                    const items = document.querySelectorAll('.n-list-item').length;
                    return items > 0
                        ? { status: 'ok', detail: `${links} 个条目链接、${items} 个 .n-list-item` }
                        : { status: 'warn', detail: `${links} 个条目链接但找不到 .n-list-item（徽章注入/填充定位可能失灵）` };
                },
            },
            {
                id: 'list-pagination', name: '列表页分页结构', path: (p) => p === '/novel',
                run: async (ctx) => {
                    await ctx.wait(() => listLinks() > 0 || !!findVisiblePagination());
                    const pag = findVisiblePagination();
                    if (!pag) return { status: 'info', detail: '本页没有分页（单页/空结果则正常）' };
                    const btns = pag.querySelectorAll('.n-pagination-item--button').length;
                    return btns > 0
                        ? { status: 'ok', detail: `分页含 ${btns} 个翻页按钮` }
                        : { status: 'warn', detail: '.n-pagination 里找不到 .n-pagination-item--button（自动翻页会失灵）' };
                },
            },
            {
                id: 'workspace-items', name: '工作区任务条目', path: (p) => p.startsWith('/workspace'),
                run: async (ctx) => {
                    await ctx.wait(() => document.querySelectorAll('.n-list-item').length > 0);
                    const items = [...document.querySelectorAll('.n-list-item')];
                    if (items.length === 0) return { status: 'info', detail: '没看到任务条目（可能没有任务）' };
                    const withDesc = items.some((it) => it.querySelector('.n-thing-main__description'));
                    return withDesc
                        ? { status: 'ok', detail: `${items.length} 个条目，含 .n-thing-main__description` }
                        : { status: 'warn', detail: '条目里找不到 .n-thing-main__description（「未完成」判定/自动重试会失灵）' };
                },
            },
        ];

        const renderIndicator = (summary) => {
            const el = scriptRef && scriptRef.siteCheckEl;
            if (!el) return;
            if (summary.warns.length) {
                el.style.display = '';
                el.textContent = `⚠ 自检 ${summary.warns.length}`;
                el.title = '站点自检发现变动（站点可能改版）：\n' + summary.warns.join('\n') + '\n（点一下输出到 Console 与日志）';
            } else {
                el.style.display = 'none';
                el.title = '';
            }
        };

        const run = async (opts = {}) => {
            if (running) { rerun = true; return lastSummary; }
            running = true;
            const my = ++epoch;
            try {
                const path = location.pathname;
                const ctx = {
                    waitMs: Number(opts.waitMs) > 0 ? Number(opts.waitMs) : 8000,
                    wait: (fn) => waitFor(fn, Number(opts.waitMs) > 0 ? Number(opts.waitMs) : 8000, my),
                };
                const site = opts.site !== undefined ? !!opts.site : isSite();
                results = [];
                for (const c of CHECKS) {
                    if (c.site && !site) { results.push({ id: c.id, name: c.name, status: 'skip', detail: '非站点域名，跳过' }); continue; }
                    if (c.path && !c.path(path)) { results.push({ id: c.id, name: c.name, status: 'skip', detail: `本页（${path}）不适用` }); continue; }
                    let r;
                    try { r = await c.run(ctx); } catch (e) { r = { status: 'info', detail: '检查出错：' + e.message }; }
                    results.push({ id: c.id, name: c.name, status: r.status, detail: r.detail });
                }
                lastPath = path;
                const warns = results.filter((r) => r.status === 'warn');
                lastSummary = {
                    at: Date.now(), path, site,
                    results: results.map((r) => ({ ...r })),
                    warns: warns.map((r) => `${r.name}：${r.detail}`),
                };
                if (warns.length) {
                    GlossaryLog.warn(`站点自检发现 ${warns.length} 处变动`, { path, issues: lastSummary.warns });
                    if (!opts.silent) NotificationUtils.showWarning(`站点自检：${warns.length} 处挂点变动（${warns.map((r) => r.name).join('、')}）——站点可能改版，相关功能会失灵`);
                } else {
                    GlossaryLog.info('站点自检通过', {
                        path,
                        ok: results.filter((r) => r.status === 'ok').length,
                        info: results.filter((r) => r.status === 'info').length,
                    });
                }
                renderIndicator(lastSummary);
                return lastSummary;
            } finally {
                running = false;
                if (rerun) { rerun = false; schedule(500); }
            }
        };

        const schedule = (delay) => {
            clearTimeout(timer);
            timer = setTimeout(() => { run().catch(() => { }); }, delay === undefined ? 1500 : delay);
        };
        // SPA 路由切换后重跑（由主循环发现 href 变化时调用）
        const onRouteChange = () => {
            if (location.pathname === lastPath) return;
            schedule(800);
        };
        const showDetails = () => {
            const lines = results.map((r) => `[${r.status}] ${r.name}：${r.detail}`);
            try { console.log('[NTA 站点自检]\n' + lines.join('\n')); } catch (e) { }
            const warns = results.filter((r) => r.status === 'warn');
            if (warns.length) NotificationUtils.showWarning(warns.map((r) => `${r.name}：${r.detail}`).join('；').slice(0, 200));
            else NotificationUtils.showSuccess('站点自检：当前页面没有发现问题');
        };
        const bind = (script) => { scriptRef = script; };
        const last = () => lastSummary;
        // 作废还在等待 DOM 的检查 + 清掉已排期的检查（路由切换/测试用）
        const cancel = () => { epoch++; clearTimeout(timer); };
        const busy = () => running;

        return { run, last, schedule, onRouteChange, showDetails, bind, cancel, busy };
    })();

    const GlossaryEngine = (() => {
        'use strict';

        // ---------- 文本工具（Normalizer.py / RubyCleaner.py / TextHelper.py） ----------

        // 全角 -> 半角（A-Z a-z 0-9）与半角片假名 -> 全角片假名
        const KANA_HALF = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝｧｨｩｪｫｬｭｮｯｰﾞﾟ';
        const KANA_FULL = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲンァィゥェォャュョッー゛゜';
        const NORMALIZE_RULE = (() => {
            const rule = {};
            for (let i = 0; i < 26; i++) {
                rule[String.fromCharCode(0xFF21 + i)] = String.fromCharCode(0x41 + i);
                rule[String.fromCharCode(0xFF41 + i)] = String.fromCharCode(0x61 + i);
            }
            for (let i = 0; i < 10; i++) {
                rule[String.fromCharCode(0xFF10 + i)] = String.fromCharCode(0x30 + i);
            }
            for (let i = 0; i < KANA_HALF.length; i++) {
                rule[KANA_HALF[i]] = KANA_FULL[i];
            }
            return rule;
        })();

        const normalize = (text) => {
            if (typeof text !== 'string') return '';
            let out = text.normalize ? text.normalize('NFC') : text;
            return out.split('').map((c) => NORMALIZE_RULE[c] || c).join('');
        };

        // 去振假名（RubyCleaner.RULE 的 10 条规则，Python -> JS 直译）
        const RUBY_RULES = [
            [/\((.+)\/.+\)/gi, '$1'],
            [/\[(.+)\/.+\]/gi, '$1'],
            [/\|(.+?)\[.+?\]/gi, '$1'],
            [/\\r\[(.+?),.+?\]/gi, '$1'],
            [/\\rb\[(.+?),.+?\]/gi, '$1'],
            [/\[r_.+?\]\[ch_(.+?)\]/gi, '$1'],
            [/\[ch_(.+?)\]/gi, '$1'],
            [/<ruby\s*=\s*.*?>(.*?)<\/ruby>/gi, '$1'],
            [/<ruby>.*?<rb>(.*?)<\/rb>.*?<\/ruby>/gi, '$1'],
            [/\[ruby text\s*=\s*.*?\]/gi, ''],
        ];
        const cleanRuby = (text) => {
            let out = text;
            for (const [re, rp] of RUBY_RULES) out = out.replace(re, rp);
            return out;
        };

        // 标点（TextHelper.py 的三个标点集合）
        const RE_CJK_PUNCT = /[\u3001-\u303F\uFF01-\uFF0F\uFF1A-\uFF1F\uFF3B-\uFF40\uFF5B-\uFF65\uFFE0-\uFFEE]/;
        const RE_LATIN_PUNCT = /[\u0021-\u002F\u003A-\u0040\u005B-\u0060\u007B-\u007E\u2000-\u206F\u2E00-\u2E7F]/;
        const RE_SPECIAL_PUNCT = /[\u00B7\u30FB\u2665]/;
        const isPunctuation = (char) => RE_CJK_PUNCT.test(char) || RE_LATIN_PUNCT.test(char) || RE_SPECIAL_PUNCT.test(char);

        // 按标点切分（TextHelper.split_by_punctuation）
        const splitByPunctuation = (text, splitBySpace) => {
            const result = [];
            let current = [];
            for (const char of text) {
                if (isPunctuation(char) || (splitBySpace && (char === ' ' || char === '\u3000'))) {
                    if (current.length > 0) {
                        result.push(current.join(''));
                        current = [];
                    }
                } else {
                    current.push(char);
                }
            }
            if (current.length > 0) result.push(current.join(''));
            return result.filter((s) => s);
        };

        // 显示宽度（TextHelper.get_display_lenght：东亚宽字符按 2 计）
        const RE_WIDE_CHAR = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|[\u{20000}-\u{3FFFD}]/u;
        const displayLength = (text) => {
            let len = 0;
            for (const char of text) len += RE_WIDE_CHAR.test(char) ? 2 : 1;
            return len;
        };

        // 语言判断（TextBase 的字符集合，用于 LanguageFilter）
        const LANG_MATCHERS = {
            ZH: /[\u4E00-\u9FFF\u3400-\u4DBF]/,
            JA: /[\u3040-\u309F\u30A0-\u30FF\u31F0-\u31FF\uFF65-\uFF9F\u4E00-\u9FFF\u3400-\u4DBF]/,
            KO: /[\u1100-\u11FF\uA960-\uA97F\uD7B0-\uD7FF\uAC00-\uD7AF\u3130-\u318F]/,
            _LATIN: /[A-Za-z\u00C0-\u024F]/,
        };
        const languageFilter = (text, sourceLanguage) => {
            const re = LANG_MATCHERS[sourceLanguage] || LANG_MATCHERS._LATIN;
            return re.test(text);  // true = 保留
        };

        // 规则过滤（RuleFilter.py，返回 true = 过滤掉）
        const RULE_PREFIX = ['mapdata/', 'se/', 'bgs', '0=', 'bgm/', 'ficon/'];
        const RULE_SUFFIX = ['.mp3', '.wav', '.ogg', 'mid', '.png', '.jpg', '.jpeg', '.gif', '.psd', '.webp', '.heif', '.heic', '.avi', '.mp4', '.webm', '.txt', '.7z', '.gz', '.rar', '.zip', '.json', '.sav', '.mps', '.ttf', '.otf', '.woff'];
        const RULE_ALL = [/^EV\d+$/i, /^DejaVu Sans$/i, /^Opendyslexic$/i, /^\{#file_time\}$/i];
        const ruleFilter = (src) => {
            const flags = [];
            for (const raw of src.split(/\r?\n/)) {
                const line = raw.trim().toLowerCase();
                if (line.trim() === '') { flags.push(true); continue; }
                if (Array.from(line).every((c) => /\s/.test(c) || /\d/.test(c) || isPunctuation(c))) { flags.push(true); continue; }
                if (RULE_PREFIX.some((v) => line.startsWith(v))) { flags.push(true); continue; }
                if (RULE_SUFFIX.some((v) => line.endsWith(v))) { flags.push(true); continue; }
                if (RULE_ALL.some((re) => re.test(line))) { flags.push(true); continue; }
                flags.push(false);
            }
            if (flags.length === 0) return false;
            return flags.every((v) => v === true);
        };

        // ---------- JSONLINE 解析（ResponseDecoder.py + json_repair 的轻量替代） ----------

        const tryParseObject = (text) => {
            try {
                const obj = JSON.parse(text);
                return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
            } catch (e) {
                return null;
            }
        };

        // 单行 JSON 修复：围栏/前后闲聊/尾逗号/单引号/未闭合字符串
        const repairJsonLine = (rawLine) => {
            let s = (rawLine || '').trim();
            if (!s || s.startsWith('```')) return null;
            s = s.replace(/[;,]\s*$/, '');
            const a = s.indexOf('{');
            const b = s.lastIndexOf('}');
            let body;
            let partial = false;
            if (a < 0) return null;
            if (b <= a) {
                // 没有闭合括号（断流），从 { 截到行尾后补齐
                body = s.slice(a);
                partial = true;
            } else {
                body = s.slice(a, b + 1);
            }

            let obj = tryParseObject(body);
            if (obj) return { obj, partial };

            // 单引号版本（当整行没有双引号时）
            if (!body.includes('"')) {
                let t = body.replace(/'/g, '"').replace(/,\s*([}\]])/g, '$1');
                if (!t.endsWith('}')) { t += '}'; partial = true; }
                obj = tryParseObject(t);
                if (obj) return { obj, partial };
            }

            // 去掉尾逗号
            let t2 = body.replace(/,\s*([}\]])/g, '$1');
            if (!t2.endsWith('}')) { t2 += '}'; partial = true; }
            obj = tryParseObject(t2);
            if (obj) return { obj, partial };

            // 未闭合字符串：补齐引号与括号
            let t3 = t2;
            const quotes = (t3.match(/(?<!\\)"/g) || []).length;
            if (quotes % 2 === 1) { t3 += '"'; }
            if (!t3.endsWith('}')) t3 += '}';
            obj = tryParseObject(t3);
            if (obj) return { obj, partial: true };

            return null;
        };

        // 剥离思考段（TaskRequester 的 reasoning_content / <think> 处理）
        const splitThink = (content) => {
            const text = typeof content === 'string' ? content : '';
            const idx = text.lastIndexOf('</think>');
            if (idx >= 0) {
                return {
                    think: text.slice(0, idx).replace(/<think>/gi, '').trim(),
                    result: text.slice(idx + '</think>'.length).trim(),
                };
            }
            return { think: '', result: text };
        };

        // 解析回复（逐行 JSONLINE）
        const parseResponse = (content) => {
            const { think, result } = splitThink(content);
            const entries = [];
            for (const line of result.split(/\r?\n/)) {
                const parsed = repairJsonLine(line);
                if (!parsed) continue;
                const obj = parsed.obj;
                if (typeof obj.src !== 'string' || !('dst' in obj)) continue;
                entries.push({
                    src: obj.src,
                    dst: typeof obj.dst === 'string' ? obj.dst : '',
                    type: typeof obj.type === 'string' ? obj.type : (typeof obj.info === 'string' ? obj.info : ''),
                    partial: parsed.partial === true,
                });
            }
            return { think, entries };
        };

        // ---------- 提示词（resource/prompt/zh/{prefix,base,suffix}.txt） ----------

        const PROMPT_PREFIX = '任务目标是从文本片段中提取指定类型的术语表，并将其翻译为{target_language}。';
        const PROMPT_BASE = [
            '任务要求：',
            '1、严格遵循任务要求，不回避不淡化不省略任何文本',
            '2、确保术语的独特性，常见的、已有约定俗成翻译方式的词语无需列入术语表',
            '3、确保术语的边界正确，术语文本中无需包含常见的称呼、称谓、称号、职位、头衔等',
            '4、确保术语的类型属于以下类型之一：男性人名、女性人名、未知性别人名、地名、家族、组织、特殊物品、特殊生物、其他',
        ].join('\n');
        const PROMPT_SUFFIX = '使用JSONLINE在代码块中输出结果，无需额外说明或解释：\n```jsonline\n{"src":"<原文>","dst":"<译文>","type":"<类型>"}\n```';

        // 定向补漏（种子轮）的附加提示：只补充"确实漏了"的写法/对象，不编造译文
        const buildFocusSection = (focus) => {
            const items = (focus || []).slice(0, 8).map((seed) => {
                const pattern = typeof seed === 'string' ? seed : seed.pattern;
                const hint = typeof seed === 'string' ? '' : (seed.hint || '');
                return `- ${pattern}${hint ? `（${hint}）` : ''}`;
            });
            return [
                '本轮为定向补漏：以下词形在本片段中出现，是本轮的重点调查对象。',
                '请特别留意它们是否还有其它写法、称谓或关联对象需要补充收录；没有独立收录价值的不要输出，不要为它们编造译文。',
                ...items,
            ].join('\n');
        };

        const buildPrompt = ({ chunkText, targetLanguage = '中文', focus }) => {
            const focusSection = focus && focus.length > 0 ? buildFocusSection(focus) + '\n' : '';
            return PROMPT_PREFIX.replace('{target_language}', targetLanguage) + '\n' + PROMPT_BASE + '\n' + PROMPT_SUFFIX + '\n' + focusSection + '文本片段：\n' + chunkText;
        };

        const buildMessages = (opts) => [{ role: 'user', content: buildPrompt(opts) }];

        // ---------- 审计（再次筛选）：让模型挑出"不该进术语表"的条目 ----------
        // 只输出"要删的"，默认全部保留 —— 模型漏答/格式坏了/请求失败，最坏结果都是"没清理"

        const AUDIT_RULES = [
            '你是术语表审核员。下面是一份从日文轻小说正文里提取出来的术语表，每行一个 JSON：',
            'src = 原文，dst = 译文，type = 类型，count = 该词在全书正文中出现的行数。',
            '',
            '术语表的作用是约束译名前后一致。凡是「读一遍就不需要统一译法」的词，都属于多余的条目。',
            '请只挑出**不该进术语表**的条目，符合以下任一条即应删除：',
            '1. 描述性短语：不是固定称呼，而是一句描述（例：「道化師のイラストが入っているペン」）。',
            '2. 通用名词：日常物品、普通设施、普通职业、泛称组织等（例：「教室」「バスケ部」「銅管楽器」）。',
            '3. 一次性的专名：count ≤ 2，且只是顺带提及的现实站名、线路、行政区、店名、商品名、活动名，或只出现一次、之后不再出现的场所（例：「代々木駅」「藤沢市」「マッシロイヌコラボのプリン」）。',
            '4. 称呼、头衔、量词、寒暄、拟声词，以及没有实际意义的单字母/单符号条目（例：「さん」「先輩」「おはよう」「O」）。',
            '5. 明显的提取错误：半截词、错位切分、把普通句子或动词片段当术语（例：「入れ」「という」）。',
            '6. 复合词不拆：由助词（の/が/を/に）把几个普通词连起来的描述性短语，不是固定的专名（例：「闇の神のマント」「道化師のイラストが入っているペン」「マッシロイヌコラボのプリン」）。但已经是固定地名的保留（例：「虹の橋」「江の島」）。',
            '7. 称呼控制：人名 + 敬称（さん/様/殿/嬢/氏）的组合（例：「アルテさん」）——术语表不该规定正文里怎么称呼；除非它就是这个角色的固定叫法。整体就是一个昵称的（例：「なるちゃん」「ゆっちゃん」）不算。',
            '8. 整句/过长：整句话被当成条目，含句读（。！？、）或长到像一句话的短语。',
            '',
            '必须保留，不得删除：',
            '① 人名（含昵称、代号、只出现一两次的配角）；',
            '② 承担剧情功能的地名、组织、家族、特殊物品、特殊生物（故事舞台、反复出现或与情节有关）；',
            '③ count ≥ 5 的条目（第 4 条里的单字母/单符号除外）；',
            '④ 类型为「男性人名 / 女性人名 / 未知性别人名 / 家族 / 特殊物品 / 特殊生物」的条目，除非它明显属于第 5~8 条。',
            '',
            '一条同时像"该删"和"该留"时，一律保留 —— 漏删的代价远小于误删（误删会让这个译名在正文里前后不一致）。',
            '不要评价译文好坏，不要改写译文，不要新增条目。',
        ].join('\n');

        const buildAuditPrompt = ({ entries, context }) => {
            const lines = [];
            if (context && context.title) {
                lines.push(`作品：${context.title}`);
                if (context.snippet) lines.push(`开头节选：${context.snippet}`);
                lines.push('');
            }
            lines.push(AUDIT_RULES);
            lines.push('');
            lines.push('待审核的术语表（JSONLINE）：');
            (entries || []).forEach((e) => lines.push(JSON.stringify({
                src: e.src,
                dst: e.dst,
                type: e.type || '',
                count: typeof e.count === 'number' ? e.count : 0,
            })));
            lines.push('');
            lines.push('输出要求：JSONLINE，只输出要删的条目，一行一条，不要任何其他内容：');
            lines.push('```jsonline');
            lines.push('{"src":"<与输入完全一致的原文>","why":"<1-5 的编号>","note":"<10 字内理由>"}');
            lines.push('```');
            return lines.join('\n');
        };

        // 审计输出没有 dst，所以不能复用 parseResponse（那个只认带 dst 的行）
        const parseAuditResponse = (text) => {
            const { result } = splitThink(text || '');
            const marks = new Map();
            let count = 0;
            for (const line of result.split(/\r?\n/)) {
                const parsed = repairJsonLine(line);
                if (!parsed) continue;
                const obj = parsed.obj;
                if (typeof obj.src !== 'string' || obj.src.trim() === '') continue;
                if (!('why' in obj) && !('note' in obj)) continue;
                count += 1;
                marks.set(obj.src.trim(), {
                    why: String(obj.why === undefined ? '' : obj.why).trim(),
                    note: String(obj.note === undefined ? '' : obj.note).trim(),
                });
            }
            return { marks, count };
        };

        // 分批送审；任何一批失败就跳过那一批（fail-open，不影响其他批次与任务状态）
        // concurrency > 1 时多批并行发出（几千条时别让用户干等十几分钟）；
        // 真正的限流/轮换仍由调用方的 requester 负责，这里只是不把批次串起来
        const auditGlossary = async ({ entries, call, context, batchSize = 300, concurrency = 1, onProgress, shouldStop }) => {
            const marks = new Map();
            const list = (entries || []).filter((e) => e && e.src);
            const size = Math.max(1, Number(batchSize) || 300);
            const batches = Math.max(1, Math.ceil(list.length / size));
            const lanes = Math.max(1, Math.min(Number(concurrency) || 1, batches));
            let unmatched = 0;
            let sent = 0;
            let done = 0;
            let next = 0;
            const failed = [];
            const worker = async () => {
                for (;;) {
                    if (shouldStop && shouldStop()) return;
                    const i = next;
                    if (i >= batches) return;
                    next += 1;
                    const batch = list.slice(i * size, (i + 1) * size);
                    if (batch.length === 0) continue;
                    const no = ++sent;
                    // phase: start = 这一批开始发；done = 这一批有结果了（成功或失败都算），供界面算进度
                    const emit = (phase) => {
                        if (!onProgress) return;
                        try { onProgress({ batch: no, batches, size: batch.length, done, phase }); } catch (e) { }
                    };
                    emit('start');
                    let content = '';
                    try {
                        const res = await call([{ role: 'user', content: buildAuditPrompt({ entries: batch, context }) }]);
                        if (!res || res.ok === false) throw new Error((res && res.error) || '请求失败');
                        content = res.content || '';
                        if (content.trim() === '') throw new Error('空响应');
                    } catch (e) {
                        failed.push(String((e && e.message) || e));
                        done += 1;
                        emit('done');
                        continue;
                    }
                    try {
                        const bySrc = new Map(batch.map((e) => [e.src, e]));
                        const byTrimmed = new Map(batch.map((e) => [String(e.src).trim(), e]));
                        parseAuditResponse(content).marks.forEach((mark, src) => {
                            const hit = bySrc.get(src) || byTrimmed.get(src);
                            if (hit) marks.set(hit.src, mark);
                            else unmatched += 1;
                        });
                    } catch (e) {
                        failed.push(String((e && e.message) || e));
                    }
                    done += 1;
                    emit('done');
                }
            };
            await Promise.all(Array.from({ length: lanes }, () => worker()));
            return { marks, unmatched, batches: sent, failed: failed.length ? failed.join('；') : '' };
        };

        // ---------- 分块（CacheManager.generate_item_chunks 的语义） ----------

        const splitLines = (text) => (text || '').split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== '');

        // 生成分块：lineLimit 避免大量短句挤爆行数
        const makeChunks = (lines, budgetChars) => {
            const lineLimit = Math.max(8, Math.floor(budgetChars / 16));
            const chunks = [];
            let chunk = [];
            let lineCount = 0;
            let charCount = 0;
            for (const line of lines) {
                const lineChars = line.length;
                if (chunk.length === 0) {
                    // 首条不判超限，避免超长行死循环
                } else if (lineCount + 1 > lineLimit || charCount + lineChars > budgetChars) {
                    chunks.push({ lines: chunk, text: chunk.join('\n') });
                    chunk = [];
                    lineCount = 0;
                    charCount = 0;
                }
                chunk.push(line);
                lineCount += 1;
                charCount += lineChars;
            }
            if (chunk.length > 0) chunks.push({ lines: chunk, text: chunk.join('\n') });
            return chunks.map((c, index) => ({ index, ...c }));
        };

        // ---------- 提取结果后处理（NERAnalyzer.save_ouput 的流水线） ----------

        const BLACKLIST_INFO = new Set(['其它', '其他', 'other', 'others']);

        // 句读：src 里出现这些基本就是「整句被当成术语」（站点指南：整句除非触发 sakura 退化，翻完必须删）
        const SENT_PUNCT = /[。．！？…‥、，；：]/;
        // 人名 + 敬称（さん/様/殿/嬢/氏）。注意「なるちゃん」这种整体就是昵称的不算
        const HONORIFIC_TAIL = /^(.*?)(さん|様|殿|嬢|氏)$/;
        // 「可疑」标记用的更宽一档：ちゃん/君/先生/先輩 这些也标上（只提示、不删，让人自己看一眼）
        const HONORIFIC_SUSPECT = /^(.*?)(さん|様|ちゃん|君|くん|先生|先輩|殿|嬢|氏|サン)$/;
        // 助词连接 = 更像短语而不是专名（「虹の橋」这种 3 字短名不在此列，交给审计判断）
        const PARTICLE_CHARS = /[のがをに]/;

        // 上一次 postProcess 丢掉了什么（通知 / 日志用）
        let lastPostDrop = { punct: 0, honorific: 0 };

        const checkEntry = (src, info) => {
            if (displayLength(src) > 32) return false;
            if (BLACKLIST_INFO.has((info || '').trim().toLowerCase())) return false;
            return true;
        };

        // 「可疑」标记（只提示，不删）：最容易违反《术语表使用指南》的几种形态
        const suspectReasons = (src) => {
            const s = String(src || '');
            const chars = Array.from(s).length;
            const reasons = [];
            if (SENT_PUNCT.test(s)) reasons.push('含标点');
            if (chars >= 13) reasons.push('过长');
            if (chars >= 6 && PARTICLE_CHARS.test(s)) reasons.push('像短语');
            const m = HONORIFIC_SUSPECT.exec(s);
            if (m && Array.from(m[1]).length >= 2) reasons.push('带敬称');
            return reasons;
        };

        const findBest = (src, choices) => {
            const dstCount = {};
            const dstChoices = [];
            const infoCount = {};
            const infoChoices = [];
            for (const choice of choices) {
                if (!(choice.dst in dstCount)) { dstCount[choice.dst] = 0; dstChoices.push(choice.dst); }
                dstCount[choice.dst] += 1;
                if (!(choice.info in infoCount)) { infoCount[choice.info] = 0; infoChoices.push(choice.info); }
                infoCount[choice.info] += 1;
            }
            const dst = dstChoices.reduce((best, v) => (dstCount[v] > dstCount[best] ? v : best), dstChoices[0]);
            const info = infoChoices.reduce((best, v) => (infoCount[v] > infoCount[best] ? v : best), infoChoices[0]);
            return {
                src,
                dst,
                type: info,
                info,
                dst_choices: dstChoices,
                info_choices: infoChoices,
                partial: choices.some((c) => c.partial === true),
            };
        };

        // 统计出现次数并附上下文（NERAnalyzer.search_for_context，含掩码防子串误配）
        // 加速：给「相邻字符对 → 出现的行下标」建倒排表，只有含这个词的行才可能命中。
        // 为什么安全：掩码只是把已匹配的字符换成 #，既不增删字符、也不改动行数与下标，
        // 所以「某个词在掩码后的行里出现」一定意味着「它在原文里也出现」→ 建表时必定收录过这一行（超集，不漏）。
        // 单字词（很少见）不走表，照旧扫全文；表按 lines 数组缓存，同一本书只建一次。
        const lineIndexCache = new WeakMap();
        const buildLineIndex = (lines) => {
            const byPair = new Map();
            lines.forEach((line, i) => {
                for (let k = 0; k + 1 < line.length; k += 1) {
                    const key = line.slice(k, k + 2);
                    const list = byPair.get(key);
                    // 行下标递增地扫进来，桶里只需比最后一个，天然去重
                    if (list) { if (list[list.length - 1] !== i) list.push(i); }
                    else byPair.set(key, [i]);
                }
            });
            return byPair;
        };
        const lineIndexFor = (lines) => {
            let index = lineIndexCache.get(lines);
            if (!index) { index = buildLineIndex(lines); lineIndexCache.set(lines, index); }
            return index;
        };
        const searchForContext = (glossary, lines) => {
            const pool = lines.slice();
            const ordered = glossary.slice().sort((a, b) => b.src.length - a.src.length);
            const byPair = lineIndexFor(lines);
            for (const entry of ordered) {
                const src = entry.src || '';
                const bucket = src.length >= 2 ? byPair.get(src.slice(0, 2)) : null;
                const hits = new Set();
                if (bucket) { for (const i of bucket) { if (pool[i].includes(src)) hits.add(i); } }
                else { pool.forEach((line, i) => { if (line.includes(src)) hits.add(i); }); }
                const contexts = [...new Set([...hits].map((i) => lines[i]))].sort((a, b) => b.length - a.length);
                entry.context = contexts;
                entry.count = contexts.length;
                hits.forEach((i) => { pool[i] = pool[i].split(src).join('#'.repeat(src.length)); });
            }
            return ordered.sort((a, b) => b.count - a.count);
        };

        // 两个行数组是否逐行一致（分块缓存命中校验用）
        const linesMatch = (a, b) => Array.isArray(a) && Array.isArray(b)
            && a.length === b.length && a.every((v, i) => v === b[i]);

        // 分块缓存记录 → 还没被任何成功块覆盖过的行（多重集差集，保持原文顺序；同一行出现多次时各自计数）
        const uncoveredLines = (allLines, records) => {
            const covered = new Map();
            (records || []).forEach((rec) => {
                const list = (rec && rec.lines) || [];
                list.forEach((line) => covered.set(line, (covered.get(line) || 0) + 1));
            });
            const rest = [];
            (allLines || []).forEach((line) => {
                const n = covered.get(line) || 0;
                if (n > 0) covered.set(line, n - 1);
                else rest.push(line);
            });
            return rest;
        };

        // 汇总原始条目 -> 最终术语表（save_ouput 的过滤/投票/去重/计数）
        // 顺带做两件零 token 的清洗（对齐站点《术语表使用指南》）：整句直接丢、人名+敬称在裸名也成条目时丢掉
        const postProcess = (entries, allLines) => {
            const group = {};
            let dropPunct = 0;
            for (const raw of entries) {
                let src = normalize(cleanRuby((raw.src || '').trim()));
                let dst = normalize(cleanRuby((raw.dst || '').trim()));
                const info = cleanRuby((raw.type || raw.info || '').trim());
                if (SENT_PUNCT.test(src)) { dropPunct += 1; continue; }
                const srcs = splitByPunctuation(src, true);
                const dsts = splitByPunctuation(dst, true);
                const pairs = (srcs.length !== dsts.length || srcs.length === 0)
                    ? [[src, dst]]
                    : srcs.map((s, i) => [s, dsts[i]]);
                for (const [s0, d0] of pairs) {
                    const s = (s0 || '').trim();
                    const d = (d0 || '').trim();
                    if (s === '' || d === '') continue;
                    if (s === d && info === '') continue;
                    if (!checkEntry(s, info)) continue;
                    if (!group[s]) group[s] = [];
                    group[s].push({ src: s, dst: d, info, partial: raw.partial === true });
                }
            }
            let glossary = Object.keys(group).map((src) => findBest(src, group[src]));
            // 去重（同 src 保留最后一个）
            const dedup = new Map();
            glossary.forEach((v) => dedup.set(v.src, v));
            glossary = [...dedup.values()];
            // 人名 + 敬称：裸名也在这张表里时丢掉带敬称的那条（指南：除非不得已不要控制称呼）
            // 裸名不存在则保留原样（由「再次筛选」打标，用户自己决定）
            const bySrc = new Set(glossary.map((v) => v.src));
            let dropHonorific = 0;
            glossary = glossary.filter((v) => {
                const m = HONORIFIC_TAIL.exec(v.src);
                if (m && Array.from(m[1]).length >= 2 && bySrc.has(m[1])) { dropHonorific += 1; return false; }
                return true;
            });
            glossary = searchForContext(glossary, allLines);
            glossary = glossary.filter((v) => v.count > 0);
            lastPostDrop = { punct: dropPunct, honorific: dropHonorific };
            return glossary;
        };

        // ---------- 限流（TaskLimiter.py 的令牌桶） ----------

        class TaskLimiter {
            constructor(rps, rpm) {
                this.rps = Number(rps) || 0;
                this.rpm = Number(rpm) || 0;
                const candidates = [];
                if (this.rps > 0) candidates.push(this.rps);
                if (this.rpm > 0) candidates.push(this.rpm / 60);
                this.rate = candidates.length > 0 ? Math.min(...candidates) : 0;
                this.maxTokens = this.rate;
                this.tokens = this.rate;
                this.last = Date.now();
            }

            async wait() {
                if (this.rate <= 0) return;
                const now = Date.now();
                this.tokens = Math.min(this.maxTokens, this.tokens + ((now - this.last) / 1000) * this.rate);
                this.last = now;
                if (this.tokens < 1) {
                    const waitMs = ((1 - this.tokens) / this.rate) * 1000;
                    await new Promise((r) => setTimeout(r, Math.max(0, waitMs)));
                    this.tokens = 1;
                    this.last = Date.now();
                }
                this.tokens -= 1;
            }
        }

        // ---------- 请求层（TaskRequester.py：worker 轮转 + 模型怪癖 + 超时） ----------

        const RE_O_SERIES = /o\d($|-)/i;
        const RE_QWEN3 = /qwen3/i;

        const buildChatUrl = (endpoint) => {
            const url = new URL(endpoint);
            if (url.pathname.endsWith('/chat/completions')) return url.href;
            if (url.pathname === '/' || url.pathname === '') url.pathname = '/v1/chat/completions';
            else if (url.pathname.endsWith('/v1') || url.pathname.endsWith('/v1/')) url.pathname = url.pathname.replace(/\/$/, '') + '/chat/completions';
            else url.pathname = url.pathname.replace(/\/$/, '') + '/chat/completions';
            return url.href;
        };

        // workers: [{ id, model, endpoint, key }]
        const createRequester = (workers, options = {}) => {
            const timeoutMs = options.timeoutMs || 300000;
            const temperature = options.temperature === undefined ? 0.3 : options.temperature;
            const thinking = options.thinking === true;
            const fetchImpl = options.fetchImpl || ((...args) => fetch(...args));
            let index = -1;
            const cooldown = new Map();  // workerId -> ts

            const cycle = () => {
                for (let i = 0; i < workers.length; i++) {
                    index = (index + 1) % workers.length;
                    const w = workers[index];
                    const until = cooldown.get(w.id) || 0;
                    if (Date.now() >= until) return w;
                }
                // 全部冷却中 -> 用第一个
                return workers[0];
            };

            const markFail = (worker) => {
                worker._fails = (worker._fails || 0) + 1;
                if (worker._fails >= 2) cooldown.set(worker.id, Date.now() + 60000);
            };
            const markOk = (worker) => { worker._fails = 0; cooldown.delete(worker.id); };

            // 回调：{ ok, content, think, error, retryAfterMs, workerId }
            const call = async (messages, override = {}) => {
                if (!workers.length) return { ok: false, error: '没有可用的翻译器' };
                const worker = override.worker || cycle();
                const model = worker.model;
                const msgs = messages.map((m) => ({ ...m }));

                const body = {
                    model,
                    messages: msgs,
                    temperature,
                };

                // 输出上限：设了才发（默认 0 = 不发送，交给上游默认值）。
                // 思考型模型（deepseek 新版 / o 系列）会把思考算进 max_tokens，固定给 8192 时
                // 思考吃满预算、正文为空（finish_reason=length）——站点自己的翻译也不发这个字段
                const maxTokens = Number(options.maxTokens) || 0;
                if (maxTokens > 0) {
                    // OpenAI O 系列 / api.openai.com：改用 max_completion_tokens
                    if ((worker.endpoint || '').startsWith('https://api.openai.com') || RE_O_SERIES.test(model || '')) {
                        body.max_completion_tokens = maxTokens;
                    } else {
                        body.max_tokens = maxTokens;
                    }
                }
                // qwen3：关闭思考时追加 /no_think
                if (RE_QWEN3.test(model || '') && thinking !== true) {
                    const last = msgs[msgs.length - 1];
                    if (last && !String(last.content).includes('/no_think')) last.content += '\n/no_think';
                }

                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeoutMs);
                try {
                    const res = await fetchImpl(buildChatUrl(worker.endpoint), {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': 'Bearer ' + (worker.key || 'no_key_required'),
                            'Accept': 'application/json',
                        },
                        body: JSON.stringify(body),
                        signal: controller.signal,
                    });
                    if (!res.ok) {
                        let bodyText = '';
                        try { bodyText = String(await res.text()).slice(0, 2000); } catch (e) { }
                        let retryAfterMs = 0;
                        const header = res.headers.get('retry-after');
                        if (header && !Number.isNaN(Number(header))) retryAfterMs = Math.max(1, Math.min(300, Number(header))) * 1000;
                        if (retryAfterMs === 0) {
                            const m = /retry[-\s]?after[\s:=]*(\d+(?:\.\d+)?)/i.exec(bodyText);
                            if (m) retryAfterMs = Math.min(300, Number(m[1])) * 1000;
                        }
                        // 上游被别的任务占用 / 限流：给出的等待往往短于任务本身耗时，加个下限
                        if (/busy|cooldown|rate.?limit/i.test(bodyText)) retryAfterMs = Math.max(retryAfterMs, 30000);
                        else if (retryAfterMs === 0 && (res.status === 429 || res.status === 503)) retryAfterMs = 30000;
                        markFail(worker);
                        // 带上上游返回的正文片段（401/402/404 这些只能靠它分辨原因）
                        const detail = bodyText.replace(/\s+/g, ' ').trim().slice(0, 180);
                        return { ok: false, status: res.status, error: `HTTP ${res.status}${detail ? '：' + detail : ''}`, retryAfterMs, workerId: worker.id };
                    }
                    const data = await res.json();
                    const message = (data.choices && data.choices[0] && data.choices[0].message) || {};
                    const finishReason = (data.choices && data.choices[0] && data.choices[0].finish_reason) || '';
                    const reasoningLen = typeof message.reasoning_content === 'string' ? message.reasoning_content.length : 0;
                    if (reasoningLen > 0) {
                        const { result } = splitThink(message.content || '');
                        markOk(worker);
                        return { ok: true, content: result !== '' ? result : (message.content || ''), think: message.reasoning_content, finishReason, reasoningLen, workerId: worker.id };
                    }
                    markOk(worker);
                    return { ok: true, content: message.content || '', finishReason, reasoningLen, workerId: worker.id };
                } catch (e) {
                    markFail(worker);
                    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message || e)));
                    // 超时被放弃时，上游可能仍在处理这个任务：按超时预算的一部分冷却，避免立刻撞上"占用中"
                    const retryAfterMs = aborted ? Math.min(300000, Math.max(15000, timeoutMs / 4)) : 10000;
                    return { ok: false, error: aborted ? '请求超时' : String((e && e.message) || e), retryAfterMs, workerId: worker.id };
                } finally {
                    clearTimeout(timer);
                }
            };

            return { call };
        };

        // ---------- 任务编排（NERAnalyzer.start 的轮次收敛） ----------

        // runJob({ lines, callLLM, options, onProgress, shouldStop, cache })
        //   callLLM(messages) -> { ok, content, error, retryAfterMs }
        //   cache: { namespace, get(key), put(key, value) } —— 分块结果缓存，用于刷新后续跑
        //   返回 { glossary, chunksDone, chunksFailed, rounds }
        // ---------- 术语表值格式（站点《术语表使用指南》约定） ----------
        // 站点把备注存在值里："译名 #备注"（站点翻译时按 split('#')[0].trim() 取用）。
        // 我们的字面匹配 / 词根派生 / 差异比对必须先剥离备注，否则带备注的术语会被误判「未落地」。

        const splitGlossaryValue = (value) => {
            const text = String(value === undefined || value === null ? '' : value);
            const index = text.indexOf('#');
            if (index < 0) return { dst: text.trim(), note: '' };
            return { dst: text.slice(0, index).trim(), note: text.slice(index + 1).trim() };
        };

        // 备注必须是简单标签（指南：禁止在备注里写作文；Sakura 也只认简单备注）
        const NOTE_MAX_CHARS = 8;
        const isSimpleNote = (note) => {
            const text = String(note || '').trim();
            if (text === '') return false;
            if (Array.from(text).length > NOTE_MAX_CHARS) return false;
            if (/[。．！？…‥、，；：\n\r]/.test(text)) return false;
            return true;
        };

        // 提取类型 → 简短备注的映射（写入用；不合格的 info 不写）
        const TYPE_NOTE = {
            '男性人名': '男性',
            '女性人名': '女性',
            '地名': '地名',
            '组织': '组织',
            '家族': '家族',
            '特殊物品': '物品',
            '特殊生物': '生物',
        };
        const formatGlossaryValue = (dst, info) => {
            const base = String(dst || '').trim();
            if (base === '') return '';
            const raw = String(info || '').trim();
            const note = TYPE_NOTE[raw] || raw;
            return isSimpleNote(note) ? `${base} #${note}` : base;
        };

        // 疑似「改原文 / 插控制符来操控翻译」（指南绝对禁止项，如 rem0 => …）。
        // 只标记不删：纯拉丁数字在日语正文里几乎不可能是真实术语，但误报代价交给人工判断。
        const SOURCE_TAMPER_PATTERN = /[\u0000-\u001F\u007F]|\\[a-zA-Z]{1,2}\[|%[0-9]*\$?[sd]|\{[^}]{0,20}\}|<[^>\s]{1,20}>/;
        const looksLikeSourceTampering = (src) => {
            const text = String(src || '').trim();
            if (text === '') return false;
            if (SOURCE_TAMPER_PATTERN.test(text)) return true;
            const hasKana = /[\u3040-\u30FF]/.test(text);
            const hasCJK = /[\u4E00-\u9FFF]/.test(text);
            const hasLatin = /[A-Za-z0-9]/.test(text);
            return !hasKana && !hasCJK && hasLatin;
        };

        // 导入侧合规检查：逐条标注 suspect（书中未见 / 疑似改原文），只提示不删
        const auditImportEntries = ({ entries, lines }) => {
            const list = (entries || []).map((e) => ({ ...e }));
            const checked = Array.isArray(lines) && lines.length > 0;
            let absent = 0;
            let tampered = 0;
            if (checked) {
                const patterns = list.map((e, i) => ({ key: i, text: normalize(cleanRuby(String((e && e.src) || '').trim())) }));
                const hits = matchPatternLineIndexes(patterns, lines);
                list.forEach((entry, i) => {
                    if ((hits.get(i) || []).length === 0) {
                        entry.suspect = [...(entry.suspect || []), '书中未见'];
                        absent += 1;
                    }
                });
            }
            list.forEach((entry) => {
                if (looksLikeSourceTampering(entry.src)) {
                    entry.suspect = [...(entry.suspect || []), '疑似改原文'];
                    tampered += 1;
                }
            });
            return { entries: list, absent, tampered, checked };
        };

        // ---------- 验收回扫（术语在译文里的落地率） ----------
        // 四态语义：
        //   absent    原文未见（可能 ruby 变体/本卷不含）——不进分母
        //   unchecked 原文出现但译文不可靠检查（dst 过短/纯标点）——不进分母
        //   missed    原文出现且译文缺 dst —— 需要人工看的清单
        //   landed    原文出现且译文含 dst
        // 与提取的 count 语义不同：这里不做长词遮蔽——单个术语出现与否应独立判定；
        // 倒排表（lineIndexFor）在无遮蔽时同样安全：含词的行的首二字符必然被建表收录（超集，不漏）。

        // dst 不适合做字面检查（过短/纯标点），单独判定而不是塞进 missed 制造虚警
        const acceptanceDstUnsafe = (dst, minDstLength) => (
            Array.from(dst).length < minDstLength
            || Array.from(dst).every((ch) => isPunctuation(ch) || ch === ' ' || ch === '\u3000')
        );

        // 编译验收匹配器：归一化 src/dst，拆成可检/不可检两组，保持术语表原始顺序
        const compileAcceptanceMatcher = (entries, options) => {
            const minDstLength = Math.max(1, Math.floor(Number(options && options.minDstLength) || 2));
            const records = [];
            (entries || []).forEach((raw, index) => {
                const src = normalize(cleanRuby(String((raw && raw.src) || '').trim()));
                const { dst: dstBase } = splitGlossaryValue((raw && raw.dst) || '');   // 剥离站点约定的 " #备注"
                const dst = normalize(cleanRuby(dstBase));
                if (src === '' || dst === '') return;
                records.push({
                    index,
                    src,
                    dst,
                    info: String((raw && (raw.type || raw.info)) || '').trim(),
                    checkable: !acceptanceDstUnsafe(dst, minDstLength),
                });
            });
            return {
                minDstLength,
                records,
                srcPatterns: records.map((r) => ({ key: r.index, text: r.src })),
                dstPatterns: records.filter((r) => r.checkable).map((r) => ({ key: r.index, text: r.dst })),
            };
        };

        // 逐词匹配（不打掩码）：返回 key -> { count, samples }，count = 含该词的行数
        const matchGlossaryPatterns = (patterns, lines, sampleLimit) => {
            const byPair = lineIndexFor(lines);
            const limit = Math.max(1, Math.floor(Number(sampleLimit) || 3));
            const result = new Map();
            for (const pattern of patterns || []) {
                const text = (pattern && pattern.text) || '';
                if (text === '') { result.set(pattern.key, { count: 0, samples: [] }); continue; }
                const bucket = text.length >= 2 ? byPair.get(text.slice(0, 2)) : null;
                let count = 0;
                const samples = [];
                const visit = (i) => {
                    if (!lines[i].includes(text)) return;
                    count += 1;
                    if (samples.length < limit) samples.push(lines[i]);
                };
                if (bucket) { for (const i of bucket) visit(i); }
                else { lines.forEach((_, i) => visit(i)); }
                result.set(pattern.key, { count, samples });
            }
            return result;
        };

        // 验收扫描：entries 术语表条目；jpLines 原文行；zhLines 译文行
        const scanAcceptance = (params) => {
            const { entries, jpLines, zhLines } = params || {};
            const compiled = compileAcceptanceMatcher(entries, params);
            const jp = matchGlossaryPatterns(compiled.srcPatterns, jpLines || [], 3);
            const zh = matchGlossaryPatterns(compiled.dstPatterns, zhLines || [], 1);
            const rows = compiled.records.map((record) => {
                const srcHit = jp.get(record.index) || { count: 0, samples: [] };
                const dstHit = zh.get(record.index) || { count: 0, samples: [] };
                let status;
                if (srcHit.count === 0) status = 'absent';
                else if (!record.checkable) status = 'unchecked';
                else if (dstHit.count > 0) status = 'landed';
                else status = 'missed';
                return {
                    src: record.src, dst: record.dst, info: record.info,
                    srcCount: srcHit.count, dstCount: dstHit.count,
                    status, sample: srcHit.samples[0] || '', dstSample: dstHit.samples[0] || '',
                };
            });
            const by = (s) => rows.filter((r) => r.status === s).length;
            const landed = by('landed');
            const missed = by('missed');
            const checkable = landed + missed;
            return {
                rows,
                stats: {
                    total: rows.length, landed, missed,
                    absent: by('absent'), unchecked: by('unchecked'),
                    checkable, rate: checkable > 0 ? landed / checkable : 0,
                },
            };
        };

        // ---------- 词根化 / 实体归并（建议，不自动改表） ----------
        // 目标：把同一族/同一体系的多个词形，归纳出一条"最短且安全"的词根，
        // 让译名一致性和匹配覆盖一起提升。是否采纳由人在合并弹层里逐条确认——
        // 词根会扩大字面匹配范围，新增命中必须核对样例（规则见 skills/glossary-extract/references/rule.md）。

        // 两个字符串的全部极大公共连续片段（长度 ≥ minLen；不含被更长匹配包含的片段）
        const maximalCommonSubstrings = (a, b, minLen) => {
            const n = a.length, m = b.length;
            const found = new Set();
            if (n === 0 || m === 0) return [];
            let prev = new Array(m + 1).fill(0);
            for (let i = 1; i <= n; i++) {
                const cur = new Array(m + 1).fill(0);
                for (let j = 1; j <= m; j++) {
                    if (a[i - 1] !== b[j - 1]) continue;
                    const len = prev[j - 1] + 1;
                    cur[j] = len;
                    // 极大性：右边不能再延长（到达串尾或下一字符不同）
                    const maximal = i === n || j === m || a[i] !== b[j];
                    if (maximal && len >= minLen) found.add(a.slice(i - len, i));
                }
                prev = cur;
            }
            return [...found];
        };

        // 最长公共子串（用于推导成员译文的公共部分）
        const longestCommonSubstring = (a, b) => {
            const n = a.length, m = b.length;
            let best = '', prev = new Array(m + 1).fill(0);
            for (let i = 1; i <= n; i++) {
                const cur = new Array(m + 1).fill(0);
                for (let j = 1; j <= m; j++) {
                    if (a[i - 1] !== b[j - 1]) continue;
                    cur[j] = prev[j - 1] + 1;
                    if (cur[j] > best.length) best = a.slice(i - cur[j], i);
                }
                prev = cur;
            }
            return best;
        };

        // 派生词根建议：entries [{src,dst}]，返回 [{root, rootDst, members:[{src,dst}], memberCount}]
        // 安全约束（宁缺勿滥，语义核对交给合并弹层里的人工）：
        //   1) root 不得等于任一现有条目（那样由现有条目覆盖，不需要新词根）；
        //   2) root 必须是所有成员的共同前缀或共同后缀——中段偶合片段（如名字里的「リー」）不算词根；
        //   3) 同一成员集合保留最长候选（更长 = 更精确；短片段才是过宽风险）
        const deriveCommonLiteralRoots = (entries, options = {}) => {
            const minLen = Math.max(2, Math.floor(Number(options.minLen) || 2));
            const minMembers = Math.max(2, Math.floor(Number(options.minMembers) || 2));
            const maxSources = Math.max(2, Math.floor(Number(options.maxSources) || 300));
            const list = (entries || [])
                .map((e) => ({
                    src: normalize(cleanRuby(String((e && e.src) || '').trim())),
                    dst: normalize(cleanRuby(splitGlossaryValue((e && e.dst) || '').dst)),   // 词根派生用剥离备注后的译名
                }))
                .filter((e) => e.src !== '' && e.dst !== '')
                .sort((a, b) => Array.from(b.src).length - Array.from(a.src).length)
                .slice(0, maxSources);
            const srcSet = new Set(list.map((e) => e.src));
            const candidates = new Map();
            for (let i = 0; i < list.length; i++) {
                for (let j = i + 1; j < list.length; j++) {
                    for (const sub of maximalCommonSubstrings(list[i].src, list[j].src, minLen)) {
                        let members = candidates.get(sub);
                        if (!members) { members = new Set(); candidates.set(sub, members); }
                        members.add(list[i].src);
                        members.add(list[j].src);
                    }
                }
            }
            const byMemberKey = new Map();
            for (const root of candidates.keys()) {
                if (srcSet.has(root)) continue;
                const members = list.filter((e) => e.src.includes(root));
                if (members.length < minMembers) continue;
                const allPrefix = members.every((e) => e.src.startsWith(root));
                const allSuffix = members.every((e) => e.src.endsWith(root));
                if (!allPrefix && !allSuffix) continue;
                const key = members.map((e) => e.src).sort().join('\u0001');
                const prev = byMemberKey.get(key);
                if (!prev || Array.from(root).length > Array.from(prev.root).length) {
                    byMemberKey.set(key, { root, members });
                }
            }
            const proposals = [...byMemberKey.values()].map(({ root, members }) => {
                let dstHint = members[0].dst;
                for (let k = 1; k < members.length; k++) dstHint = longestCommonSubstring(dstHint, members[k].dst);
                if (Array.from(dstHint || '').length < 2) dstHint = '';
                return { root, rootDst: dstHint, members, memberCount: members.length };
            });
            proposals.sort((a, b) => b.memberCount - a.memberCount || Array.from(b.root).length - Array.from(a.root).length);
            return proposals;
        };

        // 逐词命中行下标集合（词根核对用；与 matchGlossaryPatterns 不同：需要精确的行差集）
        const matchPatternLineIndexes = (patterns, lines) => {
            const byPair = lineIndexFor(lines);
            const result = new Map();
            for (const pattern of patterns || []) {
                const text = (pattern && pattern.text) || '';
                const hits = [];
                if (text !== '') {
                    const bucket = text.length >= 2 ? byPair.get(text.slice(0, 2)) : null;
                    if (bucket) { for (const i of bucket) { if (lines[i].includes(text)) hits.push(i); } }
                    else { lines.forEach((line, i) => { if (line.includes(text)) hits.push(i); }); }
                }
                result.set(pattern.key, hits);
            }
            return result;
        };

        // 核对词根覆盖：root 命中但所有成员都没命中的行 = 新增命中（采纳前必须人工看样例）
        const verifyRootCoverage = ({ root, members, lines }) => {
            const memberList = members || [];
            const patterns = [{ key: 'root', text: root }]
                .concat(memberList.map((m, i) => ({ key: `m${i}`, text: (m && m.src) || '' })));
            const hitMap = matchPatternLineIndexes(patterns, lines || []);
            const rootLines = hitMap.get('root') || [];
            const memberLines = new Set();
            memberList.forEach((m, i) => (hitMap.get(`m${i}`) || []).forEach((li) => memberLines.add(li)));
            const extra = rootLines.filter((li) => !memberLines.has(li));
            return {
                rootCount: rootLines.length,
                memberCount: memberLines.size,
                extraCount: extra.length,
                extraSamples: extra.slice(0, 3).map((li) => (lines || [])[li]),
            };
        };

        // ---------- 译文反推（从 jp-zh 对齐文本反推未收录术语的译名建议） ----------
        // 零 LLM 成本：同一原文词在一段段"原文/译文"对齐对里反复出现时，
        // 与它共同出现的汉字片段（高覆盖 + 高特异性）就是可能的译名。
        // 只是建议：进合并弹层由人确认，误报率高于提取（正文语义不参与判断）。

        const PAIR_CJK_RUN = /[\u4e00-\u9fff]{2,12}/g;
        const PAIR_KATA_RUN = /[ァ-ヴ][ァ-ヶー]{1,}/g;

        // 解析站点 jp-zh 模式的整本文本（makeTxt 格式）→ 对齐对
        // 结构：序言 → 每章 [# jp标题, # zh标题, jp段/zh段 交替…]；未翻译章节写「xx翻译缺失。」+ 仅原文
        const parseParallelText = (text) => {
            const raw = (text || '').split(/\r?\n/).map((line) => line.trim());
            const pairs = [];
            let chapters = 0;
            let translationMissing = 0;
            let chapterMissing = 0;
            let dropped = 0;
            let index = 0;
            while (index < raw.length && !/^#\s/.test(raw[index])) index += 1;   // 跳过序言
            let buffer = [];
            let skipped = false;
            let chapterTitle = '';
            for (; index < raw.length; index += 1) {
                const line = raw[index];
                if (/^#\s/.test(line)) {
                    if (buffer.length > 0) { dropped += buffer.length; buffer = []; }
                    chapters += 1;
                    chapterTitle = line.replace(/^#\s*/, '');
                    skipped = false;
                    if (index + 1 < raw.length && /^#\s/.test(raw[index + 1])) index += 1;   // jp-zh 双标题
                    continue;
                }
                if (line === '') continue;
                if (/翻译缺失/.test(line)) { translationMissing += 1; skipped = true; buffer = []; continue; }
                if (/章节缺失/.test(line)) { chapterMissing += 1; skipped = true; buffer = []; continue; }
                if (skipped) continue;
                buffer.push(line);
                if (buffer.length === 2) {
                    pairs.push({ jp: buffer[0], zh: buffer[1], chapter: chapterTitle });
                    buffer = [];
                }
            }
            if (buffer.length > 0) dropped += buffer.length;
            return { pairs, chapters, translationMissing, chapterMissing, dropped };
        };

        // 反推建议：{ pairs, glossary } → [{src, dst, pairs, support, outside, coverage, specificity, samples}]
        const inferTranslationsFromPairs = (params) => {
            const { pairs, glossary } = params || {};
            const minPairs = Math.max(2, Math.floor(Number((params && params.minPairs) || 3)));
            const maxSuggestions = Math.max(1, Math.floor(Number((params && params.maxSuggestions) || 30)));
            const maxFrequency = Math.min(1, Number((params && params.maxFrequency) || 0.2));
            const minCoverage = Math.min(1, Number((params && params.minCoverage) || 0.5));
            const minSpecificity = Math.min(1, Number((params && params.minSpecificity) || 0.6));
            const list = pairs || [];
            if (list.length === 0) return { suggestions: [], checkedPairs: 0 };
            const glossarySrcs = Object.keys(glossary || {});
            const isKnown = (src) => glossarySrcs.some((s) => s === src || s.includes(src));
            // 1) JP 侧候选：片假名串（未收录、不是已知条目的片段）
            const candPairs = new Map();
            list.forEach((pair, i) => {
                const runs = new Set((pair.jp || '').match(PAIR_KATA_RUN) || []);
                for (const raw of runs) {
                    const cand = raw.replace(/ー+$/, '');
                    if (Array.from(cand).length < 2 || isKnown(cand)) continue;
                    let arr = candPairs.get(cand);
                    if (!arr) { arr = []; candPairs.set(cand, arr); }
                    if (arr[arr.length - 1] !== i) arr.push(i);
                }
            });
            const candidates = [...candPairs.entries()]
                .filter(([, idxs]) => idxs.length >= minPairs && idxs.length / list.length <= maxFrequency)
                .sort((a, b) => b[1].length - a[1].length)
                .slice(0, Math.max(maxSuggestions * 2, 40));
            // 2) 候选对里挖汉字 n-gram（support = 覆盖的候选对数）
            const support = new Map();
            const perCandidate = new Map();
            for (const [cand, idxs] of candidates) {
                const ngrams = new Set();
                for (const i of idxs) {
                    const runs = (list[i].zh || '').match(PAIR_CJK_RUN) || [];
                    for (const run of runs) {
                        const chars = Array.from(run);
                        // 只挖 2-4 字片段：整段（≥5 字）会把前后文语素带进来，且会在平局里压过真正的短译名
                        for (let len = 2; len <= Math.min(4, chars.length); len++) {
                            for (let s = 0; s + len <= chars.length; s++) ngrams.add(chars.slice(s, s + len).join(''));
                        }
                    }
                }
                perCandidate.set(cand, ngrams);
                for (const ng of ngrams) {
                    let set = support.get(ng);
                    if (!set) { set = new Set(); support.set(ng, set); }
                    for (const i of idxs) if ((list[i].zh || '').includes(ng)) set.add(i);
                }
            }
            // 3) 特异性：全量译文行统计（只看 support 靠前的 n-gram，控制规模）
            const zhLines = list.map((p) => p.zh || '');
            const topNgrams = [...support.entries()].sort((a, b) => b[1].size - a[1].size).slice(0, 400).map(([ng]) => ng);
            const keyOf = new Map(topNgrams.map((ng, i) => [ng, i]));
            const lineIndexes = matchPatternLineIndexes(topNgrams.map((ng, i) => ({ key: i, text: ng })), zhLines);
            const suggestions = [];
            for (const [cand, idxs] of candidates) {
                let best = null;
                for (const ng of perCandidate.get(cand) || new Set()) {
                    const sup = support.get(ng) ? support.get(ng).size : 0;
                    if (sup < minPairs) continue;
                    const hits = lineIndexes.get(keyOf.get(ng));
                    const total = hits ? hits.length : sup;
                    const outside = Math.max(0, total - sup);
                    const coverage = sup / idxs.length;
                    const specificity = sup / Math.max(1, sup + outside);
                    if (coverage < minCoverage || specificity < minSpecificity) continue;
                    const score = coverage * 2 + specificity + (Array.from(ng).length <= 4 ? 0.1 : 0);
                    // 平局取更长的片段（边界更完整、过宽风险更小；「罗丝琳」优先于「丝琳」）
                    const better = !best
                        || score > best.score + 1e-9
                        || (Math.abs(score - best.score) <= 1e-9 && Array.from(ng).length > Array.from(best.ng).length);
                    if (better) {
                        best = { ng, score, sup, outside, coverage, specificity };
                    }
                }
                if (!best) continue;
                suggestions.push({
                    src: cand, dst: best.ng,
                    pairs: idxs.length, support: best.sup, outside: best.outside,
                    coverage: best.coverage, specificity: best.specificity,
                    samples: idxs.slice(0, 3).map((i) => list[i].zh),
                });
            }
            suggestions.sort((a, b) => b.support - a.support || b.coverage - a.coverage);
            return { suggestions: suggestions.slice(0, maxSuggestions), checkedPairs: list.length };
        };

        // ---------- 修句（把未落地术语改进译文，人工审核后写回站点） ----------
        // 输入是"未落地清单"：pair 的原文含术语 src、译文缺 dst。LLM 只做一件事——
        // 在不动其他内容的前提下把 dst 落进译文；写回前一律经审核面板人工确认。

        // 逐对定位未落地：pairs（jp/zh 已对齐）+ 术语表 → [{pairIndex, src, dst, jp, zh}]
        const planFixTargets = ({ pairs, glossary }) => {
            const list = pairs || [];
            const entries = Object.keys(glossary || {}).map((src) => ({ src, dst: glossary[src] }));
            const compiled = compileAcceptanceMatcher(entries, {});
            if (compiled.records.length === 0 || list.length === 0) return { targets: [], checked: 0, missedTerms: 0 };
            const jpLines = list.map((p) => p.jp || '');
            const zhLines = list.map((p) => p.zh || '');
            const jpIndex = matchPatternLineIndexes(compiled.srcPatterns, jpLines);
            const targets = [];
            const missedTerms = new Set();
            for (const record of compiled.records) {
                if (!record.checkable) continue;
                for (const lineIndex of jpIndex.get(record.index) || []) {
                    if (zhLines[lineIndex].includes(record.dst)) continue;
                    targets.push({ pairIndex: lineIndex, src: record.src, dst: record.dst, jp: jpLines[lineIndex], zh: zhLines[lineIndex] });
                    missedTerms.add(record.src);
                }
            }
            return { targets, checked: list.length, missedTerms: missedTerms.size };
        };

        // 聚合为段落级修复行：同一段落多个漏词合并；漏词多的优先，cap 封顶
        const buildFixRows = (targets, options = {}) => {
            const maxParagraphs = Math.max(1, Math.floor(Number(options.maxParagraphs) || 60));
            const byPair = new Map();
            for (const t of targets || []) {
                let row = byPair.get(t.pairIndex);
                if (!row) {
                    row = { pairIndex: t.pairIndex, jp: t.jp, zh: t.zh, missed: [] };
                    byPair.set(t.pairIndex, row);
                }
                if (!row.missed.some((m) => m.src === t.src)) row.missed.push({ src: t.src, dst: t.dst });
            }
            return [...byPair.values()]
                .sort((a, b) => b.missed.length - a.missed.length || a.pairIndex - b.pairIndex)
                .slice(0, maxParagraphs);
        };

        const FIX_RULES = [
            '你是译文术语校对员。下面给出待修段落（日文原文 + 现有译文）和必须采用的术语表（src => dst）。',
            '要求：',
            '1、只修正译文中术语不一致的地方：原文出现术语 src 时，译文必须使用对应的 dst，同一段落内保持一致',
            '2、不得改变其他任何内容：不增删信息、不改语气、不改标点风格、不合并或拆分段落',
            '3、只输出需要修改的段落；不需要修改的段落不要输出',
            '4、用 ```jsonline 代码块输出，每行一个 JSON：{"id": <段落编号>, "text": "<修正后的完整译文>"}；编号用给定 [[n]] 中的 n',
            '5、text 必须是该段修正后的完整译文（不是片段、不是解释说明）',
        ].join('\n');

        const buildFixPrompt = ({ rows }) => {
            const lines = [FIX_RULES, '', '术语表（src => dst）：'];
            const terms = new Map();
            (rows || []).forEach((row) => (row.missed || []).forEach((m) => terms.set(m.src, m.dst)));
            [...terms.entries()].forEach(([src, dst]) => lines.push(`${src} => ${dst}`));
            lines.push('', '待修段落：');
            (rows || []).forEach((row, i) => {
                lines.push(`[[${i}]]`);
                lines.push(`原文：${row.jp}`);
                lines.push(`现有译文：${row.zh}`);
                lines.push('');
            });
            return lines.join('\n');
        };

        // 解析修句响应：容错取 {"id":n,"text":"..."}（复用 JSONLINE 修复器）
        const parseFixResponse = (content, options = {}) => {
            const rowCount = Math.max(0, Math.floor(Number(options.rowCount) || 0));
            const fixes = new Map();
            let invalid = 0;
            const block = /```(?:jsonline)?\s*([\s\S]*?)```/.exec(content || '');
            const text = block ? block[1] : (content || '');
            for (const line of text.split(/\r?\n/)) {
                const parsed = repairJsonLine(line);
                if (!parsed || !parsed.obj) continue;
                const id = Number(parsed.obj.id);
                const out = parsed.obj.text;
                if (!Number.isInteger(id) || id < 0 || id >= rowCount || typeof out !== 'string' || out.trim() === '') {
                    invalid += 1;
                    continue;
                }
                fixes.set(id, out.trim());
            }
            return { fixes, invalid };
        };

        // 章节段落数组里按原文定位（同文本多处出现时按出现顺序分配，避免重复占用）
        const locateParagraph = (paragraphJp, text, used) => {
            const usedSet = used || new Set();
            for (let i = 0; i < (paragraphJp || []).length; i += 1) {
                if (usedSet.has(i)) continue;
                if (paragraphJp[i] === text) return i;
            }
            return -1;
        };

        // ---------- 种子补漏（种子账本驱动的定向收敛轮） ----------
        // 主轮跑完后，把「已发现词形」转成有具体调查目标的种子：敬称裸名 / 敬称写法 /
        // 片假名的平假名写法 / 未收录的片假名信号串。只有真实出现在正文里的才算种子（能定向定位行）。
        // 种子账本不落盘：由「本轮提取结果 + 已处理行」确定性重算，配合分块缓存天然支持断点续跑。

        const KATAKANA_RUN = /[ァ-ヴ][ァ-ヶー]{2,}/g;   // 含长音符 ー（否则 ローズリーン 会被切断）
        const KATAKANA_HAS = /[ァ-ヴ][ァ-ヶー]{2,}/;
        const toHiragana = (text) => text.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));

        // 派生种子：entries 已提取条目；lines 已处理的正文行；exclude 已消费过的模式（账本）
        const deriveSeeds = ({ entries, lines, maxSeeds = 24, exclude }) => {
            const srcs = (entries || []).map((e) => (e && e.src) || '').filter((s) => s !== '');
            const srcSet = new Set(srcs);
            const seeds = [];
            const taken = new Set();
            const push = (pattern, kind, hint) => {
                if (seeds.length >= maxSeeds) return;
                if (!pattern || Array.from(pattern).length < 2 || srcSet.has(pattern) || taken.has(pattern)) return;
                if (exclude && typeof exclude.has === 'function' && exclude.has(pattern)) return;
                let hits = 0;
                const samples = [];
                for (const line of lines || []) {
                    if (line.includes(pattern)) {
                        hits += 1;
                        if (samples.length < 3) samples.push(line);
                    }
                }
                if (hits === 0) return; // 只在正文里真实出现的才算种子
                taken.add(pattern);
                seeds.push({ pattern, kind, hint, hits, samples });
            };
            // 1) 敬称变体 → 裸名
            for (const e of entries || []) {
                const m = HONORIFIC_TAIL.exec((e && e.src) || '');
                if (m && m[1] && Array.from(m[1]).length >= 2) push(m[1], 'honorific', `${e.src} 的裸名`);
            }
            // 2) 裸名 → 正文中实际出现的称谓写法（含ちゃん/君/くん/先生/先輩 这类呼び方）
            for (const e of entries || []) {
                const src = (e && e.src) || '';
                if (HONORIFIC_TAIL.test(src) || Array.from(src).length < 2) continue;
                for (const suffix of ['さん', '様', '殿', '嬢', '氏', 'ちゃん', '君', 'くん', '先生', '先輩']) {
                    push(src + suffix, 'honorific', `${src} 的称谓写法`);
                }
            }
            // 3) 片假名条目 → 平假名写法（儿童语/口语变体）
            for (const e of entries || []) {
                const src = (e && e.src) || '';
                if (!KATAKANA_HAS.test(src)) continue;
                const hira = toHiragana(src);
                if (hira !== src) push(hira, 'kana', `${src} 的平假名写法`);
            }
            // 4) 未收录的片假名信号串（按频次取，跳过被现有条目包含的片段）
            const runCount = new Map();
            for (const line of lines || []) {
                const runs = line.match(KATAKANA_RUN) || [];
                for (const raw of runs) {
                    const run = raw.replace(/ー+$/, '');
                    if (run.length < 3) continue;
                    if (srcSet.has(run)) continue;
                    if (srcs.some((s) => s.includes(run))) continue;
                    runCount.set(run, (runCount.get(run) || 0) + 1);
                }
            }
            [...runCount.entries()].sort((a, b) => b[1] - a[1]).forEach(([run]) => push(run, 'signal', '未收录的片假名串'));
            return seeds;
        };

        // 定向分块：按种子聚合行，再按预算与小桶合并；同一行只进一次请求，focus 带上相关种子
        const buildSeedChunks = (seeds, lines, budgetChars, options = {}) => {
            const maxChunks = Math.max(1, options.maxChunks || 6);
            const maxLinesPerSeed = Math.max(4, options.maxLinesPerSeed || 40);
            const focusCap = Math.max(1, options.focusCap || 6);
            const buckets = seeds.map((seed) => ({
                seed,
                lines: (lines || []).filter((line) => line.includes(seed.pattern)).slice(0, maxLinesPerSeed),
            })).filter((b) => b.lines.length > 0);
            const chunks = [];
            let current = { lines: [], lineSet: new Set(), focus: [], chars: 0 };
            const flush = () => {
                if (current.lines.length > 0) {
                    chunks.push({ index: chunks.length, lines: current.lines, text: current.lines.join('\n'), focus: current.focus });
                }
                current = { lines: [], lineSet: new Set(), focus: [], chars: 0 };
            };
            for (const bucket of buckets) {
                if (chunks.length >= maxChunks) break;
                const fresh = bucket.lines.filter((line) => !current.lineSet.has(line));
                const freshChars = fresh.reduce((n, line) => n + line.length, 0);
                const coveredByCurrent = fresh.length === 0;
                if (current.lines.length > 0 && (current.chars + freshChars > budgetChars || current.focus.length >= focusCap)) flush();
                for (const line of fresh) {
                    current.lines.push(line);
                    current.lineSet.add(line);
                }
                current.chars += freshChars;
                if (current.focus.length < focusCap && (fresh.length > 0 || coveredByCurrent)) current.focus.push(bucket.seed);
                // 单种子行数超预算：拆成多个块（同 focus），保证每块不超预算
                if (current.chars >= budgetChars) flush();
            }
            flush();
            return chunks.slice(0, maxChunks);
        };

        // ---------- 证据化核实（对候选做正向判定：收录资格/类型） ----------
        // 提取阶段是"宁滥勿缺"的单次判断；核实阶段把每条的命中证据打包后批量送模型，
        // 回答"是否值得收录、是什么类型"。判定为剔除的条目标 verifyDrop（保留在结果里供人工复核），
        // 请求失败的批次 fail-open（未判定的条目一律保留）。

        // 证据打包：每条候选的命中行索引与上下文样本（样本数封顶）
        const collectEvidence = ({ entries, lines, maxSamples = 3 }) => {
            const list = lines || [];
            const patterns = (entries || []).map((e, i) => ({ key: i, text: normalize(cleanRuby(String((e && e.src) || '').trim())) }));
            const hits = matchPatternLineIndexes(patterns, list);
            return (entries || []).map((entry, i) => {
                const indexes = hits.get(i) || [];
                return {
                    src: (entry && entry.src) || '',
                    count: indexes.length,
                    samples: indexes.slice(0, Math.max(1, maxSamples)).map((li) => list[li]),
                };
            });
        };

        const VERIFY_RULES = [
            '你是术语核实员。下面是术语候选和它在正文里的出现情况。',
            '术语表只收「多次出现的专有名词」（人名、地名、组织、家族、作品特有的物品/技能/概念）；普通名词、描述性短语、称呼、整句都不收。',
            '逐条给出：keep（是否值得收录）、type（类型，取：男性人名/女性人名/未知性别人名/地名/家族/组织/特殊物品/特殊生物/其他）、reason（一句话理由）。',
            '不确定时 keep 用 true——后续还有人工复核，漏收的代价更大。',
            '用 ```jsonline 代码块输出，每行一个 JSON：{"src":"<原文>","keep":true,"type":"<类型>","reason":"<理由>"}；src 必须与给定候选完全一致。',
        ].join('\n');

        const buildVerifyPrompt = ({ items }) => {
            const lines = [VERIFY_RULES, ''];
            (items || []).forEach((item) => {
                lines.push(`- ${item.src}（出现 ${item.count} 行）`);
                (item.samples || []).slice(0, 2).forEach((sample) => lines.push(`  例：${sample}`));
            });
            return lines.join('\n');
        };

        // 解析核实响应；bySrc：归一化 src → 原始 src 列表（同名归一后可能对应多条）
        const parseVerifyResponse = (content, options = {}) => {
            const bySrc = (options && options.bySrc) || new Map();
            const results = new Map();
            let invalid = 0;
            const block = /```(?:jsonline)?\s*([\s\S]*?)```/.exec(content || '');
            const text = block ? block[1] : (content || '');
            for (const line of text.split(/\r?\n/)) {
                const parsed = repairJsonLine(line);
                if (!parsed || !parsed.obj) continue;
                const obj = parsed.obj;
                if (typeof obj.src !== 'string' || typeof obj.keep !== 'boolean') { invalid += 1; continue; }
                const key = normalize(cleanRuby(obj.src.trim()));
                const originals = bySrc.get(key);
                if (!originals || originals.length === 0) { invalid += 1; continue; }
                const mark = {
                    keep: obj.keep,
                    type: typeof obj.type === 'string' ? obj.type.trim() : '',
                    reason: typeof obj.reason === 'string' ? obj.reason.trim() : '',
                };
                originals.forEach((src) => results.set(src, mark));
            }
            return { results, invalid };
        };

        // 核实编排：分批 + 并发 lane（与 auditGlossary 同构），fail-open
        const verifyEntries = async ({ entries, lines, call, batchSize = 20, concurrency = 2, shouldStop, onProgress }) => {
            const list = entries || [];
            if (list.length === 0 || typeof call !== 'function') {
                return { entries: list, checked: 0, kept: list.length, dropped: 0, invalid: 0, failedBatches: 0 };
            }
            const evidence = collectEvidence({ entries: list, lines });
            const bySrc = new Map();
            evidence.forEach((item) => {
                const key = normalize(cleanRuby(String(item.src || '').trim()));
                if (!bySrc.has(key)) bySrc.set(key, []);
                bySrc.get(key).push(item.src);
            });
            const size = Math.max(1, Math.floor(Number(batchSize) || 20));
            const batches = [];
            for (let i = 0; i < evidence.length; i += size) batches.push(evidence.slice(i, i + size));
            const marks = new Map();
            let invalid = 0;
            let failedBatches = 0;
            let done = 0;
            let cursor = 0;
            const lane = async () => {
                for (;;) {
                    if (shouldStop && shouldStop()) return;
                    const myIndex = cursor;
                    cursor += 1;
                    if (myIndex >= batches.length) return;
                    let result;
                    try {
                        result = await call([{ role: 'user', content: buildVerifyPrompt({ items: batches[myIndex] }) }]);
                    } catch (e) {
                        result = { ok: false, error: String((e && e.message) || e) };
                    }
                    if (result && result.ok && String(result.content || '').trim() !== '') {
                        const parsed = parseVerifyResponse(result.content, { bySrc });
                        invalid += parsed.invalid;
                        for (const [src, mark] of parsed.results) marks.set(src, mark);
                    } else {
                        failedBatches += 1;
                    }
                    done += 1;
                    if (onProgress) onProgress({ done, total: batches.length, marks: marks.size });
                }
            };
            await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), batches.length) }, () => lane()));
            let kept = 0;
            let dropped = 0;
            const validTypes = new Set(['男性人名', '女性人名', '未知性别人名', '地名', '家族', '组织', '特殊物品', '特殊生物', '其他']);
            const out = list.map((entry) => {
                const mark = marks.get(entry.src);
                if (!mark) { kept += 1; return entry; }
                const enriched = { ...entry, verified: mark };
                if (!enriched.type && validTypes.has(mark.type)) enriched.type = mark.type;
                if (mark.keep) { kept += 1; return enriched; }
                dropped += 1;
                return { ...enriched, verifyDrop: true };
            });
            return { entries: out, checked: marks.size, kept, dropped, invalid, failedBatches };
        };

        // ---------- 实体聚类（共现信号：疑似同实体多写法的候选组） ----------
        // 纯程序信号，不做自动合并：同实体最可靠的程序证据是「反复出现在同一行」——
        // 人名并列、称谓+本名、别称介绍句都符合；公共前后缀另由词根整理覆盖。
        // 输出交给人工（词根整理模块展示），与"只建议不自动改"的纪律一致。

        const buildEntityClusters = ({ entries, lines, minSharedLines = 2, maxClusters = 30 }) => {
            const list = (entries || [])
                .map((e, index) => ({ src: normalize(cleanRuby(String((e && e.src) || '').trim())), index }))
                .filter((e) => e.src !== '' && Array.from(e.src).length >= 2);
            if (list.length < 2) return { clusters: [], checked: list.length };
            const bySrc = matchPatternLineIndexes(list.map((e, i) => ({ key: i, text: e.src })), lines || []);
            const lineToEntries = new Map();
            list.forEach((entry, i) => {
                for (const li of bySrc.get(i) || []) {
                    if (!lineToEntries.has(li)) lineToEntries.set(li, []);
                    lineToEntries.get(li).push(i);
                }
            });
            const pairShared = new Map();
            const pairSamples = new Map();
            for (const [li, indexes] of lineToEntries) {
                if (indexes.length < 2 || indexes.length > 8) continue;   // 一行出现太多条目多半是列表页，跳过
                for (let a = 0; a < indexes.length; a += 1) {
                    for (let b = a + 1; b < indexes.length; b += 1) {
                        const key = indexes[a] < indexes[b] ? `${indexes[a]}|${indexes[b]}` : `${indexes[b]}|${indexes[a]}`;
                        pairShared.set(key, (pairShared.get(key) || 0) + 1);
                        if (!pairSamples.has(key)) pairSamples.set(key, []);
                        if (pairSamples.get(key).length < 3) pairSamples.get(key).push((lines || [])[li]);
                    }
                }
            }
            const parent = list.map((_, i) => i);
            const find = (x) => { let cur = x; while (parent[cur] !== cur) cur = parent[cur]; return cur; };
            const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent[rb] = ra; };
            const threshold = Math.max(2, Math.floor(Number(minSharedLines) || 2));
            for (const [key, shared] of pairShared) {
                if (shared < threshold) continue;
                const [a, b] = key.split('|').map(Number);
                union(a, b);
            }
            const groups = new Map();
            list.forEach((entry, i) => {
                const root = find(i);
                if (!groups.has(root)) groups.set(root, []);
                groups.get(root).push(entry);
            });
            const clusters = [];
            for (const members of groups.values()) {
                if (members.length < 2) continue;
                let sharedLines = 0;
                const samples = [];
                for (let a = 0; a < members.length; a += 1) {
                    for (let b = a + 1; b < members.length; b += 1) {
                        const key = members[a].index < members[b].index ? `${members[a].index}|${members[b].index}` : `${members[b].index}|${members[a].index}`;
                        const shared = pairShared.get(key) || 0;
                        if (shared < threshold) continue;
                        sharedLines += shared;
                        (pairSamples.get(key) || []).forEach((s) => samples.push(s));
                    }
                }
                const srcs = members.map((m) => m.src);
                let root = '';
                const first = srcs[0];
                for (let len = first.length; len >= 2; len -= 1) {
                    const candidate = first.slice(0, len);
                    if (srcs.every((s) => s.startsWith(candidate))) { root = candidate; break; }
                }
                if (!root) {
                    for (let len = first.length; len >= 2; len -= 1) {
                        const candidate = first.slice(-len);
                        if (srcs.every((s) => s.endsWith(candidate))) { root = candidate; break; }
                    }
                }
                clusters.push({
                    members: srcs,
                    sharedLines,
                    samples: [...new Set(samples)].slice(0, 3),
                    root,
                });
            }
            clusters.sort((a, b) => b.sharedLines - a.sharedLines);
            return { clusters: clusters.slice(0, Math.max(1, maxClusters)), checked: list.length };
        };

        const runJob = async ({ lines, callLLM, options = {}, onProgress, shouldStop, cache }) => {
            const budget = options.budgetChars || 3000;
            const maxRounds = options.maxRounds || 3;
            const concurrency = Math.max(1, options.concurrency || 2);
            const limiter = new TaskLimiter(options.rps || concurrency, options.rpm || 0);
            const allEntries = [];
            const processedLines = [];
            let pending = lines.slice();
            let chunksDone = 0;
            let chunksFailed = 0;
            let round = 0;
            GlossaryLog.info('提取开始', { lines: lines.length, maxRounds, budget, concurrency, rpm: options.rpm || 0, cache: !!cache });

            // 失败后的全局冷却（上游限流 / 被放弃的任务可能仍在上游运行）
            let cooldownUntil = 0;
            const waitCooldown = async () => {
                while (Date.now() < cooldownUntil) {
                    if (shouldStop && shouldStop()) return false;
                    await new Promise((r) => setTimeout(r, Math.min(500, cooldownUntil - Date.now())));
                }
                return true;
            };

            const report = (extra) => onProgress && onProgress({
                round, maxRounds, chunksDone, chunksFailed,
                pendingLines: pending.length, totalLines: lines.length,
                coveredLines: processedLines.length, ...extra,
            });

            while (pending.length > 0 && round < maxRounds) {
                if (shouldStop && shouldStop()) break;
                // 第 1、2 轮用同一个预算（瞬时失败原样再来一次，能不拆就不拆），第 3 轮起才减半
                const roundBudget = Math.max(200, Math.floor(budget / Math.pow(2, Math.max(0, round - 1))));
                const chunks = makeChunks(pending, roundBudget);
                const failedLines = [];
                const attempted = new Set();
                let cursor = 0;

                report({ phase: 'round-start', totalChunks: chunks.length });
                GlossaryLog.info(`第 ${round + 1}/${maxRounds} 轮开始`, { chunks: chunks.length, budget: roundBudget, pendingLines: pending.length });

                const worker = async () => {
                    while (true) {
                        if (shouldStop && shouldStop()) return;
                        const myIndex = cursor;
                        cursor += 1;
                        if (myIndex >= chunks.length) return;
                        const chunk = chunks[myIndex];
                        attempted.add(myIndex);
                        const cacheKey = cache && cache.namespace ? `${cache.namespace}/r${round}/c${chunk.index}` : null;

                        // 命中缓存：直接复用该块结果（刷新/重开页面后续跑的核心）
                        // 键里只有「轮次 + 序号」，不含分块预算：改了分块字数或轮次预算映射后，
                        // 同一个键会对应到不同的块内容 → 命中也要核对行，错位的记录按未命中处理
                        if (cacheKey) {
                            const hit = await cache.get(cacheKey).catch(() => undefined);
                            if (hit && Array.isArray(hit.entries) && linesMatch(hit.lines, chunk.lines)) {
                                allEntries.push(...hit.entries);
                                processedLines.push(...chunk.lines);
                                chunksDone += 1;
                                GlossaryLog.debug('缓存命中', { round: round + 1, chunk: chunk.index, lines: chunk.lines.length });
                                report({ phase: 'chunk-cached', chunkIndex: chunk.index });
                                continue;
                            }
                        }

                        const chunkT0 = Date.now();
                        await limiter.wait();
                        if (!(await waitCooldown())) { failedLines.push(...chunk.lines); return; }
                        const messages = buildMessages({ chunkText: chunk.text, targetLanguage: options.targetLanguage || '中文' });
                        let result;
                        try {
                            result = await callLLM(messages);
                        } catch (e) {
                            result = { ok: false, error: String((e && e.message) || e) };
                        }
                        // 上游限流降级时可能返回 200 但内容为空：按失败处理，否则整块会被标记完成却提取不到任何术语
                        const contentOk = result && result.ok && String(result.content || '').trim() !== '';
                        if (contentOk) {
                            const parsed = parseResponse(result.content || '');
                            for (const entry of parsed.entries) allEntries.push(entry);
                            processedLines.push(...chunk.lines);
                            chunksDone += 1;
                            GlossaryLog.debug('块完成', {
                                round: round + 1, chunk: chunk.index, worker: result && result.workerId,
                                ms: Date.now() - chunkT0, entries: parsed.entries.length, chars: chunk.text.length,
                            });
                            if (cacheKey) await cache.put(cacheKey, { entries: parsed.entries, lines: chunk.lines, at: Date.now() }).catch(() => { });
                        } else {
                            failedLines.push(...chunk.lines);
                            chunksFailed += 1;
                            if (result && result.retryAfterMs) {
                                cooldownUntil = Math.max(cooldownUntil, Date.now() + result.retryAfterMs);
                                report({ phase: 'cooldown', waitMs: result.retryAfterMs });
                            }
                            const reason = result && result.ok
                                ? `上游返回空内容（finish_reason=${(result && result.finishReason) || '?'}，思考 ${(result && result.reasoningLen) || 0} 字${result && result.finishReason === 'length' ? '，输出预算被思考吃满：把「输出上限」设 0（不发送）或调大' : ''}）`
                                : ((result && result.error) || '未知错误');
                            GlossaryLog.warn('chunk failed: ' + reason, {
                                round: round + 1, chunk: chunk.index, worker: result && result.workerId,
                                ms: Date.now() - chunkT0, cooldownMs: (result && result.retryAfterMs) || 0,
                            });
                        }
                        report({ phase: 'chunk-done', chunkIndex: chunk.index });
                    }
                };

                await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()));

                // 停止时会有块完全没轮到（worker 在取块前就退出了）：这些行也要还给 pending，
                // 否则「待 N 行」会显示成 0，看起来像是全都处理完了
                for (let i = 0; i < chunks.length; i += 1) {
                    if (!attempted.has(i)) failedLines.push(...chunks[i].lines);
                }
                pending = failedLines;
                round += 1;
            }

            // ---------- 种子补漏（多轮账本驱动，链式收敛） ----------
            // 每轮：派生未消费种子 → 定向块 → 执行；种子消费入账；本轮新发现物在下一轮派生新种子。
            // 收敛：无新种子，或轮数封顶（maxSeedRounds）。补漏尽力而为：失败不回流 pending、不阻塞完成。
            // 账本可序列化（options.seedLedger 传入/回传），队列随任务持久化；分块缓存按 `s{轮}-{块}` 复用。
            let seedInfo = [];
            let polishChunks = 0;
            let seedChunksFailed = 0;
            const ledger = (options.seedLedger && typeof options.seedLedger === 'object')
                ? {
                    v: 1,
                    consumed: Array.isArray(options.seedLedger.consumed) ? [...options.seedLedger.consumed] : [],
                    rounds: Array.isArray(options.seedLedger.rounds) ? [...options.seedLedger.rounds] : [],
                    done: options.seedLedger.done === true,
                }
                : { v: 1, consumed: [], rounds: [], done: false };
            const consumedSeeds = new Set(ledger.consumed);
            const maxSeedRounds = Math.max(1, Math.floor(Number(options.maxSeedRounds) || 3));
            if (options.seedPolish !== false && pending.length === 0 && processedLines.length > 0 && !(shouldStop && shouldStop())) {
                for (let seedRound = 0; seedRound < maxSeedRounds && !ledger.done; seedRound += 1) {
                    if (shouldStop && shouldStop()) break;
                    const seeds = deriveSeeds({
                        entries: allEntries,
                        lines: processedLines,
                        maxSeeds: Math.max(1, options.maxSeeds || 24),
                        exclude: consumedSeeds,
                    });
                    if (seeds.length === 0) { ledger.done = true; break; }   // 收敛：没有新的调查目标
                    const directed = buildSeedChunks(seeds, processedLines, budget, {
                        maxChunks: Math.max(1, options.maxSeedChunks || 6),
                        maxLinesPerSeed: Math.max(4, options.maxLinesPerSeed || 40),
                    });
                    if (directed.length === 0) { ledger.done = true; break; }
                    polishChunks += directed.length;
                    seedInfo.push(...seeds.map((s) => ({ pattern: s.pattern, kind: s.kind, hits: s.hits })));
                    report({ phase: 'seed-start', seedRound: seedRound + 1, seedCount: seeds.length, totalChunks: directed.length });
                    GlossaryLog.info(`种子补漏 第 ${seedRound + 1} 轮`, {
                        seeds: seeds.length, chunks: directed.length, patterns: seeds.slice(0, 8).map((s) => s.pattern),
                    });
                    const entriesBefore = allEntries.length;
                    let seedCursor = 0;
                    const seedWorker = async () => {
                        for (;;) {
                            if (shouldStop && shouldStop()) return;
                            const myIndex = seedCursor;
                            seedCursor += 1;
                            if (myIndex >= directed.length) return;
                            const chunk = directed[myIndex];
                            const cacheKey = cache && cache.namespace ? `${cache.namespace}/s${seedRound}-${myIndex}` : null;
                            if (cacheKey) {
                                const hit = await cache.get(cacheKey).catch(() => undefined);
                                if (hit && Array.isArray(hit.entries) && linesMatch(hit.lines, chunk.lines)) {
                                    allEntries.push(...hit.entries);
                                    GlossaryLog.debug('种子块缓存命中', { round: seedRound + 1, chunk: myIndex, lines: chunk.lines.length });
                                    report({ phase: 'seed-chunk-cached', chunkIndex: myIndex });
                                    continue;
                                }
                            }
                            const seedT0 = Date.now();
                            await limiter.wait();
                            if (!(await waitCooldown())) return;
                            let result;
                            try {
                                result = await callLLM(buildMessages({
                                    chunkText: chunk.text,
                                    targetLanguage: options.targetLanguage || '中文',
                                    focus: chunk.focus,
                                }));
                            } catch (e) {
                                result = { ok: false, error: String((e && e.message) || e) };
                            }
                            const seedOk = result && result.ok && String(result.content || '').trim() !== '';
                            if (seedOk) {
                                const parsed = parseResponse(result.content || '');
                                for (const entry of parsed.entries) allEntries.push(entry);
                                if (cacheKey) await cache.put(cacheKey, { entries: parsed.entries, lines: chunk.lines, at: Date.now() }).catch(() => { });
                                GlossaryLog.debug('种子块完成', {
                                    round: seedRound + 1, chunk: myIndex, ms: Date.now() - seedT0,
                                    entries: parsed.entries.length, focus: chunk.focus.map((s) => s.pattern),
                                });
                            } else {
                                seedChunksFailed += 1;
                                if (result && result.retryAfterMs) {
                                    cooldownUntil = Math.max(cooldownUntil, Date.now() + result.retryAfterMs);
                                    report({ phase: 'cooldown', waitMs: result.retryAfterMs });
                                }
                                GlossaryLog.warn('种子块失败: ' + ((result && result.error) || '空响应'), {
                                    round: seedRound + 1, chunk: myIndex, focus: chunk.focus.map((s) => s.pattern),
                                });
                            }
                            report({ phase: 'seed-chunk-done', chunkIndex: myIndex });
                        }
                    };
                    await Promise.all(Array.from({ length: Math.min(concurrency, directed.length) }, () => seedWorker()));
                    if (shouldStop && shouldStop()) break;   // 停止：本轮不消费不记账，续跑时重放（缓存复用已完成块）
                    seeds.forEach((s) => consumedSeeds.add(s.pattern));
                    ledger.rounds.push({
                        seeds: seeds.map((s) => s.pattern),
                        chunks: directed.length,
                        newEntries: allEntries.length - entriesBefore,
                    });
                    if (seedRound + 1 >= maxSeedRounds) ledger.done = true;   // 轮数封顶
                }
            }

            const glossary = postProcess(allEntries, processedLines);
            report({ phase: 'done', seeds: seedInfo.length, polishChunks, seedChunksFailed, seedRounds: ledger.rounds.length });
            GlossaryLog.info('提取结束', {
                entries: glossary.length, chunksDone, chunksFailed, rounds: round,
                pendingLines: pending.length, processedLines: processedLines.length, dropped: { ...lastPostDrop },
                seeds: seedInfo.length, polishChunks, seedChunksFailed, seedRounds: ledger.rounds.length,
            });
            return {
                glossary, chunksDone, chunksFailed, rounds: round, pendingLines: pending.length,
                processedLines, dropped: { ...lastPostDrop }, seeds: seedInfo, polishChunks, seedChunksFailed,
                seedLedger: ledger, seedRounds: ledger.rounds.length,
            };
        };

        // 导出
        return {
            // 文本工具
            normalize, cleanRuby, isPunctuation, splitByPunctuation, displayLength,
            languageFilter, ruleFilter, splitLines, makeChunks,
            // 解析
            repairJsonLine, splitThink, parseResponse,
            // 提示词
            PROMPT_PREFIX, PROMPT_BASE, PROMPT_SUFFIX, buildPrompt, buildMessages,
            // 审计（再次筛选）
            AUDIT_RULES, buildAuditPrompt, parseAuditResponse, auditGlossary,
            // 后处理
            postProcess, findBest, searchForContext, linesMatch, uncoveredLines,
            suspectReasons, postDrop: () => ({ ...lastPostDrop }),
            // 验收回扫
            compileAcceptanceMatcher, matchGlossaryPatterns, scanAcceptance,
            // 词根化 / 实体归并
            maximalCommonSubstrings, longestCommonSubstring, deriveCommonLiteralRoots,
            matchPatternLineIndexes, verifyRootCoverage,
            // 译文反推
            parseParallelText, inferTranslationsFromPairs,
            // 修句
            planFixTargets, buildFixRows, buildFixPrompt, parseFixResponse, locateParagraph, FIX_RULES,
            // 种子补漏
            deriveSeeds, buildSeedChunks, buildFocusSection,
            // 证据化核实
            collectEvidence, buildVerifyPrompt, parseVerifyResponse, verifyEntries, VERIFY_RULES,
            // 实体聚类
            buildEntityClusters,
            // 术语表值格式（指南约定）
            splitGlossaryValue, isSimpleNote, formatGlossaryValue, looksLikeSourceTampering, auditImportEntries,
            // 请求 / 编排
            TaskLimiter, buildChatUrl, createRequester, runJob,
        };
    })();
    // ==GlossaryEngine-END==

    // -----------------------------------
    // Glossary DB (IndexedDB: ntr-glossary，存队列/分块结果/快照)
    // -----------------------------------
    // ==GlossaryDB-START==
    const GlossaryDB = (() => {
        const DB_NAME = 'ntr-glossary';
        const VERSION = 1;
        let dbPromise = null;

        const open = () => {
            if (dbPromise) return dbPromise;
            dbPromise = new Promise((resolve, reject) => {
                const req = indexedDB.open(DB_NAME, VERSION);
                req.onupgradeneeded = () => {
                    const db = req.result;
                    if (!db.objectStoreNames.contains('jobs')) db.createObjectStore('jobs', { keyPath: 'id' });
                    if (!db.objectStoreNames.contains('chunks')) db.createObjectStore('chunks', { keyPath: 'id' });
                    if (!db.objectStoreNames.contains('snapshots')) db.createObjectStore('snapshots', { keyPath: 'id' });
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
            });
            return dbPromise;
        };

        const run = async (store, mode, fn) => {
            const db = await open();
            return new Promise((resolve, reject) => {
                const t = db.transaction(store, mode);
                const s = t.objectStore(store);
                let request;
                try {
                    request = fn(s);
                } catch (e) {
                    reject(e);
                    return;
                }
                t.oncomplete = () => resolve(request ? request.result : undefined);
                t.onerror = () => reject(t.error);
                t.onabort = () => reject(t.error);
            });
        };

        // 请求持久化存储，避免被浏览器按配额回收
        const requestPersist = async () => {
            try {
                if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
            } catch (e) { }
            return false;
        };

        return {
            put: (store, value) => run(store, 'readwrite', (s) => s.put(value)),
            get: (store, key) => run(store, 'readonly', (s) => s.get(key)),
            getAll: (store) => run(store, 'readonly', (s) => s.getAll()),
            delete: (store, key) => run(store, 'readwrite', (s) => s.delete(key)),
            clear: (store) => run(store, 'readwrite', (s) => s.clear()),
            requestPersist,
        };
    })();
    // ==GlossaryDB-END==

    // -----------------------------------
    // Glossary Targets (网页小说 / 本地卷 的术语表读写)
    // -----------------------------------
    const GlossaryTargets = (() => {
        const openVolumesDB = () => new Promise((resolve, reject) => {
            // 与站点 stores/local/LocalVolumeDao.ts 相同：DB volumes v2
            const req = indexedDB.open('volumes', 2);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });

        const reqPromise = (request) => new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        const targetKey = (target) => {
            if (target.kind === 'web') return `web:${target.providerId}/${target.novelId}`;
            if (target.kind === 'wenku') return `wenku:${target.novelId}`;
            if (target.kind === 'local') return `local:${target.volumeId}`;
            return 'unknown';
        };

        const describe = (target) => {
            if (target.kind === 'web') return `网页小说 ${target.providerId}/${target.novelId}`;
            if (target.kind === 'wenku') return `文库小说 ${target.novelId}`;
            if (target.kind === 'local') return `本地卷 ${target.volumeId}`;
            return '未知目标';
        };

        // 读取现有术语表
        const loadGlossary = async (target) => {
            if (target.kind === 'web') {
                const res = await script.fetch(`${window.location.origin}/api/novel/${target.providerId}/${target.novelId}`);
                if (!res.ok) throw new Error(`读取术语表失败: HTTP ${res.status}`);
                const data = await res.json();
                return data.glossary || {};
            }
            if (target.kind === 'wenku') {
                const res = await script.fetch(`${window.location.origin}/api/wenku/${target.novelId}`);
                if (!res.ok) throw new Error(`读取术语表失败: HTTP ${res.status}`);
                const data = await res.json();
                return data.glossary || {};
            }
            if (target.kind === 'local') {
                const db = await openVolumesDB();
                const meta = await reqPromise(db.transaction('metadata', 'readonly').objectStore('metadata').get(target.volumeId));
                if (meta === undefined) throw new Error('本地卷不存在');
                return meta.glossary || {};
            }
            throw new Error('未知目标');
        };

        // 写入术语表（网页端为全量替换语义，必须自行合并；本地卷更新 glossaryId）
        const saveGlossary = async (target, glossary) => {
            if (target.kind === 'web' || target.kind === 'wenku') {
                const url = target.kind === 'web'
                    ? `${window.location.origin}/api/novel/${target.providerId}/${target.novelId}/glossary`
                    : `${window.location.origin}/api/wenku/${target.novelId}/glossary`;
                const res = await script.fetch(url, true, {
                    method: 'PUT',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(glossary),
                });
                if (!res.ok) throw new Error(`写入失败: HTTP ${res.status}`);
                return { refresh: false };
            }
            if (target.kind === 'local') {
                const db = await openVolumesDB();
                const tx = db.transaction('metadata', 'readwrite');
                const store = tx.objectStore('metadata');
                const meta = await reqPromise(store.get(target.volumeId));
                if (meta === undefined) throw new Error('本地卷不存在');
                meta.glossary = glossary;
                // 与站点 LocalVolumeRepository.updateGlossary 一致：更换 glossaryId 以标记过期
                meta.glossaryId = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());
                await reqPromise(store.put(meta));
                await new Promise((resolve) => { tx.oncomplete = resolve; tx.onerror = resolve; });
                return { refresh: true };
            }
            throw new Error('未知目标');
        };

        // 快照：每次写入前把「写入前」的术语表存成一个版本，用于回滚
        const SNAPSHOT_KEEP = 20;

        const snapshotMatch = (record, key) => !!record && (record.key === key || (record.key === undefined && record.id === key));

        // 每个目标只保留最近 SNAPSHOT_KEEP 个版本
        const pruneSnapshots = async (key) => {
            const all = await GlossaryDB.getAll('snapshots');
            const mine = (all || []).filter((r) => snapshotMatch(r, key));
            if (mine.length <= SNAPSHOT_KEEP) return;
            mine.sort((a, b) => (b.createAt || 0) - (a.createAt || 0));
            for (const record of mine.slice(SNAPSHOT_KEEP)) {
                await GlossaryDB.delete('snapshots', record.id);
            }
        };

        const takeSnapshot = async (target, glossary, note) => {
            const key = targetKey(target);
            const createAt = Date.now();
            const record = { id: `${key}#${createAt}`, key, target, glossary, note: note || '', createAt };
            await GlossaryDB.put('snapshots', record);
            await pruneSnapshots(key);
            return record;
        };

        // 版本列表（新→旧）。兼容早期单条快照记录（id 就是 targetKey、没有 key 字段）
        const listSnapshots = async (target) => {
            const key = targetKey(target);
            const all = await GlossaryDB.getAll('snapshots');
            return (all || [])
                .filter((r) => snapshotMatch(r, key))
                .sort((a, b) => (b.createAt || 0) - (a.createAt || 0));
        };

        // 兼容旧接口：取最近一个版本
        const getSnapshot = async (target) => (await listSnapshots(target))[0];

        const rollback = async (target, snapshotId) => {
            const snap = snapshotId
                ? await GlossaryDB.get('snapshots', snapshotId)
                : await getSnapshot(target);
            if (!snap) throw new Error('没有可用的快照');
            const current = await loadGlossary(target);
            await takeSnapshot(target, current, '回滚前自动快照');
            await saveGlossary(target, snap.glossary);
            return snap;
        };

        // 本地卷：读取全文（chapter store 按 toc 顺序拼接段落）
        const loadLocalVolumeText = async (volumeId) => {
            const db = await openVolumesDB();
            const meta = await reqPromise(db.transaction('metadata', 'readonly').objectStore('metadata').get(volumeId));
            if (meta === undefined) throw new Error('本地卷不存在');
            const chapters = await reqPromise(db.transaction('chapter', 'readonly').objectStore('chapter').index('byVolumeId').getAll(volumeId));
            // 章节记录的 chapterId 编码在 id 里（`${volumeId}/${chapterId}`），记录本身没有 chapterId 字段
            const byId = new Map((chapters || []).map((c) => [String(c.id).slice(volumeId.length + 1), c]));
            let ordered = meta.toc && meta.toc.length > 0
                ? meta.toc.map((it) => byId.get(String(it.chapterId))).filter(Boolean)
                : (chapters || []);
            if (ordered.length === 0) ordered = chapters || [];
            const text = ordered.map((c) => (c.paragraphs || []).join('\n')).join('\n');
            return { meta, text };
        };

        const listLocalVolumes = async () => {
            const db = await openVolumesDB();
            const metas = await reqPromise(db.transaction('metadata', 'readonly').objectStore('metadata').getAll());
            return (metas || []).sort((a, b) => (b.createAt || 0) - (a.createAt || 0)).map((m) => ({
                id: m.id,
                createAt: m.createAt,
                favoriedId: m.favoredId,
                glossaryCount: Object.keys(m.glossary || {}).length,
                chapters: (m.toc || []).length,
            }));
        };

        return { targetKey, describe, loadGlossary, saveGlossary, takeSnapshot, listSnapshots, getSnapshot, rollback, loadLocalVolumeText, listLocalVolumes };
    })();

    // -----------------------------------
    // Glossary UI (预览-合并-diff 弹层 + 进度浮窗)
    // -----------------------------------
    // ==GlossaryUI-START==
    const GlossaryUI = (() => {
        const CSS_ID = 'ntr-glossary-css';
        // 「次数过滤」的阈值记忆（弹层跨模块共用，所以不挂在某个模块的设置里）
        const COUNT_MIN_KEY = 'ntr-glossary-count-min';
        const readCountMin = () => {
            try {
                const v = Number(localStorage.getItem(COUNT_MIN_KEY));
                return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
            } catch (e) { return 0; }
        };
        const saveCountMin = (v) => {
            try {
                if (v > 0) localStorage.setItem(COUNT_MIN_KEY, String(v));
                else localStorage.removeItem(COUNT_MIN_KEY);
            } catch (e) { }
        };
        // 审计判废类别的可读名字（提示词里的编号 → 展示文案）
        const AUDIT_CATEGORY = {
            '1': '描述性短语',
            '2': '通用名词',
            '3': '一次性专名',
            '4': '称呼/符号',
            '5': '提取错误',
        };
        const AUDIT_BATCH_SIZE = 300;   // 每个审计请求最多带多少条（条数 ÷ 这个值 = 请求数）
        const auditTitle = (audit) => {
            if (!audit) return '';
            const cat = AUDIT_CATEGORY[String(audit.why || '').trim()] || `第 ${audit.why} 类`;
            return audit.note ? `${cat}：${audit.note}` : cat;
        };
        const ensureStyles = () => {
            if (document.getElementById(CSS_ID)) return;
            const style = document.createElement('style');
            style.id = CSS_ID;
            style.textContent = `
.ntr-g-overlay { position: fixed; inset: 0; z-index: 999999; background: rgba(0,0,0,0.72); display: flex; align-items: center; justify-content: center; font-family: Arial, "Microsoft YaHei", sans-serif; }
.ntr-g-overlay .ntr-g-card { background: #1E1E1E; color: #CCC; width: min(1180px, 96vw); height: min(88vh, 900px); border: 1px solid #333; border-radius: 10px; display: flex; flex-direction: column; overflow: hidden; box-shadow: 0 8px 40px rgba(0,0,0,0.6); }
.ntr-g-overlay .ntr-g-head { padding: 10px 14px; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ntr-g-overlay .ntr-g-title { font-size: 15px; color: #EEE; font-weight: bold; }
.ntr-g-overlay .ntr-g-stats { font-size: 12px; color: #999; }
.ntr-g-overlay .ntr-g-eta { margin-left: auto; color: #9CC7A8; }
.ntr-g-overlay .ntr-g-toolbar { padding: 8px 14px; border-bottom: 1px solid #2a2a2a; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12px; }
/* 队列工具栏按钮多（12 个），收紧间距/内边距让 1080 宽下不换行；「运行翻译器」选中 worker 后会变长，限宽省略 */
#ntr-queue-overlay .ntr-g-toolbar { gap: 5px; }
#ntr-queue-overlay .ntr-g-toolbar .ntr-g-btn { font-size: 12px; padding: 5px 8px; white-space: nowrap; }
#ntr-queue-overlay .ntr-g-toolbar .ntr-g-shrink { max-width: 170px; overflow: hidden; text-overflow: ellipsis; }
.ntr-g-overlay .ntr-g-tab { padding: 3px 10px; border: 1px solid #3a3a3a; border-radius: 12px; cursor: pointer; color: #AAA; background: #262626; }
.ntr-g-overlay .ntr-g-tab.active { background: #2E5A2E; border-color: #4a8a4a; color: #DFD; }
.ntr-g-overlay input[type=text], .ntr-g-overlay input[type=number] { background: #232323; border: 1px solid #3a3a3a; color: #CCC; border-radius: 4px; padding: 3px 8px; }
.ntr-g-overlay .ntr-g-body { flex: 1; overflow: auto; }
.ntr-g-overlay table { width: 100%; border-collapse: collapse; font-size: 12px; }
.ntr-g-overlay th { position: sticky; top: 0; background: #292929; color: #BBB; text-align: left; padding: 6px 8px; border-bottom: 1px solid #3a3a3a; z-index: 1; }
.ntr-g-overlay td { padding: 4px 8px; border-bottom: 1px solid #242424; vertical-align: middle; }
.ntr-g-overlay tr.status-add td:first-child { box-shadow: inset 3px 0 0 #3f9f3f; }
.ntr-g-overlay tr.status-conflict td:first-child { box-shadow: inset 3px 0 0 #d0a020; }
.ntr-g-overlay tr.status-same td:first-child { box-shadow: inset 3px 0 0 #555; }
.ntr-g-overlay tr.status-existing td:first-child { box-shadow: inset 3px 0 0 #3860a0; }
.ntr-g-overlay .ntr-g-badge { font-size: 11px; padding: 1px 6px; border-radius: 8px; background: #333; color: #CCC; white-space: nowrap; }
.ntr-g-overlay .ntr-g-badge.add { background: #2E5A2E; color: #CFC; }
.ntr-g-overlay .ntr-g-badge.conflict { background: #5A4A1E; color: #FEC; }
.ntr-g-overlay .ntr-g-badge.same { background: #333; }
.ntr-g-overlay .ntr-g-badge.existing { background: #24384F; color: #CDF; }
.ntr-g-overlay .ntr-g-badge.partial { background: #5A2E2E; color: #FCC; }
.ntr-g-overlay .ntr-g-foot { padding: 10px 14px; border-top: 1px solid #333; display: flex; gap: 10px; align-items: center; justify-content: flex-end; flex-wrap: wrap; }
.ntr-g-overlay .ntr-g-btn { background: #2f2f2f; color: #DDD; border: 1px solid #444; border-radius: 6px; padding: 6px 14px; cursor: pointer; font-size: 13px; }
.ntr-g-overlay .ntr-g-btn:hover { background: #3a3a3a; }
.ntr-g-overlay .ntr-g-btn.primary { background: #2E5A2E; border-color: #4a8a4a; color: #EFE; }
.ntr-g-overlay .ntr-g-btn.primary:hover { background: #386b38; }
.ntr-g-overlay .ntr-g-btn.danger { background: #5A2E2E; border-color: #8a4a4a; }
.ntr-g-overlay .ntr-g-btn:disabled { opacity: 0.45; cursor: not-allowed; }
.ntr-g-overlay .ntr-g-warn { font-size: 12px; color: #E8C46A; flex: 1; }
.ntr-g-overlay th.ntr-g-sortable { cursor: pointer; user-select: none; }
.ntr-g-overlay th.ntr-g-sortable:hover { color: #EEE; background: #313131; }
.ntr-g-overlay .ntr-g-sort-mark { margin-left: 4px; color: #7ab87a; font-size: 10px; }
.ntr-g-overlay .ntr-g-types { padding: 6px 14px; border-bottom: 1px solid #2a2a2a; display: flex; flex-wrap: wrap; gap: 8px; align-items: center; font-size: 12px; color: #AAA; }
.ntr-g-overlay .ntr-g-types-lead { color: #888; margin-right: 2px; }
.ntr-g-overlay .ntr-g-type-item { display: inline-flex; align-items: center; gap: 4px; cursor: pointer; background: #262626; border: 1px solid #3a3a3a; border-radius: 12px; padding: 2px 9px; }
.ntr-g-overlay .ntr-g-type-item:hover { background: #303030; }
.ntr-g-overlay .ntr-g-type-item input { margin: 0; }
.ntr-g-overlay .ntr-g-tab-eof { margin-left: 0; }
.ntr-g-overlay .ntr-g-filter-btn.on { border-color: #7ab87a; color: #CFC; }
.ntr-g-overlay .ntr-g-popover { position: absolute; top: calc(100% + 6px); right: 0; z-index: 5; width: 360px; background: #232323; border: 1px solid #3d3d3d; border-radius: 8px; box-shadow: 0 10px 30px rgba(0,0,0,0.55); padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
.ntr-g-overlay .ntr-g-pop-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; color: #BBB; }
.ntr-g-overlay .ntr-g-pop-row input[type=number] { width: 62px; }
.ntr-g-overlay .ntr-g-pop-hint { font-size: 11px; color: #888; }
.ntr-g-overlay .ntr-g-pop-sep { height: 1px; background: #3a3a3a; margin: 2px 0; }
.ntr-g-overlay .ntr-g-pop-title { font-size: 11px; color: #888; }
.ntr-g-overlay tr.ntr-g-row-filtered td { opacity: 0.42; }
.ntr-g-overlay .ntr-g-badge.lowcount { background: #333; color: #999; }
.ntr-g-overlay .ntr-g-badge.audit { background: #4A3A1E; color: #F5D08A; }
.ntr-g-overlay .ntr-g-badge.suspect { background: #24384F; color: #BFD8FF; }
#ntr-glossary-status { position: fixed; right: 20px; top: 70px; z-index: 999998; background: #1E1E1E; color: #CCC; border: 1px solid #333; border-radius: 8px; padding: 10px 14px; font-family: Arial, "Microsoft YaHei", sans-serif; font-size: 12px; width: 320px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
#ntr-glossary-status .ntr-gs-line { margin-bottom: 6px; }
#ntr-glossary-status .ntr-gs-bar { height: 6px; background: #333; border-radius: 3px; overflow: hidden; margin: 6px 0; }
#ntr-glossary-status .ntr-gs-bar > div { height: 100%; background: #4a8a4a; width: 0%; transition: width 0.2s; }
`;
            document.head.appendChild(style);
        };

        // 对比现有术语表，生成行与统计
        // suspect：命中《术语表使用指南》里那几类形态（过长/像短语/带敬称/含标点）的标记，只提示不删
        const computeDiff = (entries, existing) => {
            const rows = entries.map((entry) => {
                const has = Object.prototype.hasOwnProperty.call(existing, entry.src);
                // 站点值可能是 "译名 #备注"：比对按剥离备注后的 base 判 same/conflict
                const existingBase = has ? GlossaryEngine.splitGlossaryValue(existing[entry.src]).dst : undefined;
                const entryBase = GlossaryEngine.splitGlossaryValue(entry.dst).dst;
                let status = 'add';
                if (has && existingBase === entryBase) status = 'same';
                else if (has) status = 'conflict';
                // 既有形态标记（过长/像短语/带敬称/含标点）+ 模块注入的自定义标记（书中未见/疑似改原文）
                const suspect = [...GlossaryEngine.suspectReasons(entry.src), ...(Array.isArray(entry.suspect) ? entry.suspect : [])];
                return { ...entry, existing: has ? existing[entry.src] : undefined, status, suspect: [...new Set(suspect)] };
            });
            const covered = new Set(entries.map((e) => e.src));
            Object.keys(existing).forEach((src) => {
                if (!covered.has(src)) rows.push({ src, dst: existing[src], type: '', count: 0, status: 'existing' });
            });
            const order = { add: 0, conflict: 1, same: 2, existing: 3 };
            rows.sort((a, b) => (order[a.status] - order[b.status]) || (b.count - a.count));
            const stats = {
                total: entries.length,
                add: rows.filter((r) => r.status === 'add').length,
                conflict: rows.filter((r) => r.status === 'conflict').length,
                same: rows.filter((r) => r.status === 'same').length,
                existing: rows.filter((r) => r.status === 'existing').length,
            };
            return { rows, stats };
        };

        const fmtText = (glossary) => Object.keys(glossary).map((k) => `${k} => ${glossary[k]}`).join('\n');
        const fmtJson = (glossary) => JSON.stringify(glossary, null, 2);

        const copyText = async (text) => {
            try {
                await navigator.clipboard.writeText(text);
                NotificationUtils.showSuccess('已复制到剪贴板');
            } catch (e) {
                // 剪贴板不可用时退回 textarea 选择
                const ta = document.createElement('textarea');
                ta.value = text;
                document.body.appendChild(ta);
                ta.select();
                try { document.execCommand('copy'); NotificationUtils.showSuccess('已复制到剪贴板'); }
                catch (err) { NotificationUtils.showError('复制失败'); }
                ta.remove();
            }
        };

        const downloadText = (filename, text) => {
            const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 500);
        };

        // 进度浮窗：返回 { update(text, ratio), close() }
        const status = (titleText, { onStop } = {}) => {
            ensureStyles();
            let box = document.getElementById('ntr-glossary-status');
            if (box) box.remove();
            box = document.createElement('div');
            box.id = 'ntr-glossary-status';
            const title = document.createElement('div');
            title.className = 'ntr-gs-line';
            title.style.color = '#EEE';
            title.textContent = titleText;
            const line = document.createElement('div');
            line.className = 'ntr-gs-line';
            line.textContent = '准备中…';
            const bar = document.createElement('div');
            bar.className = 'ntr-gs-bar';
            const fill = document.createElement('div');
            bar.appendChild(fill);
            box.appendChild(title);
            box.appendChild(line);
            box.appendChild(bar);
            if (onStop) {
                const btn = document.createElement('button');
                btn.className = 'ntr-g-btn';
                btn.textContent = '停止';
                btn.style.marginTop = '4px';
                btn.onclick = () => { onStop(); btn.disabled = true; btn.textContent = '正在停止…'; };
                box.appendChild(btn);
            }
            document.body.appendChild(box);
            return {
                update: (text, ratio) => {
                    line.textContent = text;
                    if (ratio !== undefined) fill.style.width = Math.max(0, Math.min(100, ratio * 100)) + '%';
                },
                close: () => box.remove(),
            };
        };

        // 预览-合并-diff 弹层
        // options: { title, target, entries, existing, mode: 'preview'|'merge'|'restore', onWrite(glossary, rows), onRestore(), enableImport, confirmRestore, auditConcurrency }
        // restore 模式：entries = 目标版本的术语表，existing = 当前术语表；新增/覆盖/删除 就是回滚的影响面
        // auditConcurrency：审计分几批并行发（只影响提示文案，真正的并行在 auditGlossary 里）
        const open = ({ title, target, entries, existing, mode = 'preview', onWrite, onRestore, enableImport = false, confirmRestore = true, onAudit, auditConcurrency = 1 }) => {
            ensureStyles();
            const old = document.getElementById('ntr-glossary-overlay');
            if (old) old.remove();

            const state = {
                filter: 'all',
                query: '',
                selected: new Set(),
                dsts: {},
                conflictPolicy: 'keep',   // keep = 保留现有；override = 采用新提取
                source: '',               // 从文件载入时记录文件名
                sortKey: '',              // '' = 原始顺序；否则 src/dst/count/type/existing/status
                sortDir: 1,               // 1 = 升序，-1 = 降序
                countMin: readCountMin(), // 次数过滤：0 = 不过滤（localStorage 记忆）
                showFiltered: false,      // 显示被次数过滤掉的行（灰色、不可勾选）
                auditBusy: false,         // 正在跑「再次筛选」
                auditNote: '',            // 上次筛选的结果提示
                history: [],              // 撤销栈：{selected:Set, audits:Map} 快照（上限 30）
                auditBaseline: null,      // 审计开始前的快照（撤销清洗用）
            };
            let rows = [];
            let stats = { total: 0, add: 0, conflict: 0, same: 0, existing: 0 };
            let rebuildTypes = () => { };   // 类型复选框那行（DOM 建好后才有实现）
            // 次数过滤：只作用于真实提取出来的条目（有 count 的新增/冲突/相同）。
            // 「仅已有」行与 restore 模式（快照没有次数，count 一律是 0）不参与过滤，否则会被静默藏掉。
            const isLowCount = (row) => mode !== 'restore' && state.countMin > 0
                && row.status !== 'existing' && typeof row.count === 'number' && row.count < state.countMin;
            const lowCountRows = () => rows.filter(isLowCount);
            const auditRows = () => rows.filter((row) => row.audit);

            // ---- 撤销：勾选 + 标记 的快照栈（任何改动前压栈，上限 30 步） ----
            const snapshot = () => ({
                selected: new Set(state.selected),
                audits: new Map(rows.filter((row) => row.audit).map((row) => [row._index, row.audit])),
            });
            const pushHistory = () => {
                state.history.push(snapshot());
                if (state.history.length > 30) state.history.shift();
            };
            const restoreSnapshot = (snap) => {
                state.selected = new Set(snap.selected);
                rows.forEach((row) => {
                    if (snap.audits.has(row._index)) row.audit = snap.audits.get(row._index);
                    else delete row.audit;
                });
            };
            const undo = () => {
                const snap = state.history.pop();
                if (!snap) return false;
                restoreSnapshot(snap);
                return true;
            };
            const setEntries = (list) => {
                const diff = computeDiff(list, existing);
                rows = diff.rows;
                stats = diff.stats;
                state.selected.clear();
                state.dsts = {};
                rows.forEach((row, i) => {
                    row._index = i;
                    state.dsts[i] = row.dst;
                    // 默认勾上「新增」；带「建议删」标记的不默认勾选（先打标、写入由用户确认）
                    if (mode === 'merge' && row.status === 'add' && !row.partial && !row.audit) state.selected.add(i);
                });
                rebuildTypes();
            };
            setEntries(entries);

            const overlay = document.createElement('div');
            overlay.id = 'ntr-glossary-overlay';
            overlay.className = 'ntr-g-overlay';

            const card = document.createElement('div');
            card.className = 'ntr-g-card';
            overlay.appendChild(card);

            // 头部
            const head = document.createElement('div');
            head.className = 'ntr-g-head';
            const titleEl = document.createElement('div');
            titleEl.className = 'ntr-g-title';
            titleEl.textContent = title;
            const statsEl = document.createElement('div');
            statsEl.className = 'ntr-g-stats';
            head.appendChild(titleEl);
            head.appendChild(statsEl);
            card.appendChild(head);

            // 工具条
            const toolbar = document.createElement('div');
            toolbar.className = 'ntr-g-toolbar';
            const tabDefs = mode === 'restore'
                ? [['all', '全部'], ['add', '新增'], ['conflict', '覆盖'], ['same', '相同'], ['existing', '将删除']]
                : [['all', '全部'], ['add', '新增'], ['conflict', '冲突'], ['same', '相同'], ['existing', '仅已有']];
            const tabEls = {};
            tabDefs.forEach(([key, label]) => {
                const tab = document.createElement('span');
                tab.className = 'ntr-g-tab' + (key === 'all' ? ' active' : '');
                tab.textContent = label;
                tab.onclick = () => {
                    state.filter = key;
                    Object.keys(tabEls).forEach((k) => tabEls[k].classList.toggle('active', k === key));
                    render();
                };
                tabEls[key] = tab;
                toolbar.appendChild(tab);
            });
            // 「建议删」页签：审计打过标才出现
            let auditTab = null;
            if (mode !== 'restore') {
                auditTab = document.createElement('span');
                auditTab.className = 'ntr-g-tab';
                auditTab.id = 'ntr-g-audit-tab';
                auditTab.style.display = 'none';
                auditTab.textContent = '建议删 (0)';
                auditTab.onclick = () => {
                    state.filter = 'audit';
                    Object.keys(tabEls).forEach((k) => tabEls[k].classList.toggle('active', k === 'audit'));
                    render();
                };
                tabEls.audit = auditTab;
                toolbar.appendChild(auditTab);
            }
            // 「可疑」页签：命中指南里那几类形态的条目（只提示，不自动删）；
            // 纯新增的条目里也有（比如一次性的长短语），先看一眼再决定写不写
            let suspectTab = null;
            if (mode !== 'restore') {
                suspectTab = document.createElement('span');
                suspectTab.className = 'ntr-g-tab';
                suspectTab.id = 'ntr-g-suspect-tab';
                suspectTab.style.display = 'none';
                suspectTab.textContent = '可疑 (0)';
                suspectTab.title = '命中《术语表使用指南》里那几类形态（过长 / 像短语 / 带敬称 / 含标点）——只打标记，不删除、不改勾选';
                suspectTab.onclick = () => {
                    state.filter = 'suspect';
                    Object.keys(tabEls).forEach((k) => tabEls[k].classList.toggle('active', k === 'suspect'));
                    render();
                };
                tabEls.suspect = suspectTab;
                toolbar.appendChild(suspectTab);
            }
            const searchInput = document.createElement('input');
            searchInput.type = 'text';
            searchInput.placeholder = '搜索 src / dst…';
            searchInput.style.marginLeft = 'auto';
            searchInput.style.width = '220px';
            searchInput.oninput = () => { state.query = searchInput.value.trim(); render(); };
            toolbar.appendChild(searchInput);

            if (enableImport) {
                const btnPick = document.createElement('button');
                btnPick.className = 'ntr-g-btn';
                btnPick.id = 'ntr-g-pick-file';
                btnPick.textContent = '选择 JSON 文件';
                btnPick.title = '支持 KWG 导出的 output.json（对象数组）/ output_autonovel.json（扁平 JSON）/ “原文 => 译文” 文本；也可以把文件直接拖进这个窗口';
                btnPick.onclick = () => pickFile();
                toolbar.appendChild(btnPick);
            }

            if (mode === 'merge') {
                const selectAdd = document.createElement('button');
                selectAdd.className = 'ntr-g-btn';
                selectAdd.textContent = '全选新增/冲突';
                selectAdd.onclick = () => { pushHistory(); selectableRows().forEach((r) => { if (r.status === 'add' || r.status === 'conflict') state.selected.add(r._index); }); render(); };
                const selectNone = document.createElement('button');
                selectNone.className = 'ntr-g-btn';
                selectNone.textContent = '全不选';
                selectNone.onclick = () => { pushHistory(); selectableRows().forEach((r) => state.selected.delete(r._index)); render(); };
                const conflictBtn = document.createElement('button');
                conflictBtn.className = 'ntr-g-btn';
                conflictBtn.id = 'ntr-g-conflict-btn';
                const syncConflictBtn = () => {
                    // 标签直接写清「现在是什么状态」（之前只写两个选项来回换，容易看糊）
                    conflictBtn.textContent = state.conflictPolicy === 'keep'
                        ? '冲突：现在「保留现有」（点击改用新提取）'
                        : '冲突：现在「采用新提取」（点击改回保留现有）';
                    conflictBtn.title = state.conflictPolicy === 'keep'
                        ? '冲突条目不写入（保留站点现有译文）；点一下改成写入新提取的译文'
                        : '冲突条目会写入新提取的译文（需勾选）；点一下改成保留站点现有译文';
                };
                conflictBtn.onclick = () => {
                    state.conflictPolicy = state.conflictPolicy === 'keep' ? 'override' : 'keep';
                    // 策略切换时同步勾选：采用新提取 -> 勾上全部冲突行；保留现有 -> 取消勾选
                    rows.forEach((row) => {
                        if (row.status !== 'conflict') return;
                        if (state.conflictPolicy === 'override') state.selected.add(row._index);
                        else state.selected.delete(row._index);
                    });
                    syncConflictBtn();
                    render();
                };
                syncConflictBtn();
                toolbar.appendChild(selectAdd);
                toolbar.appendChild(selectNone);
                toolbar.appendChild(conflictBtn);
            }

            // ---------- 「筛选 ▾」浮出面板：次数过滤 / 再次筛选 / 撤销 ----------
            let btnFilter = null;
            let popover = null;
            let syncFilterPanel = () => { };
            if (mode !== 'restore') {
                toolbar.style.position = 'relative';
                btnFilter = document.createElement('button');
                btnFilter.className = 'ntr-g-btn';
                btnFilter.id = 'ntr-g-filter-btn';
                toolbar.appendChild(btnFilter);

                popover = document.createElement('div');
                popover.className = 'ntr-g-popover';
                popover.id = 'ntr-g-filter-popover';
                popover.style.display = 'none';
                toolbar.appendChild(popover);

                const setPopoverOpen = (open_) => {
                    popover.style.display = open_ ? 'flex' : 'none';
                    syncFilterPanel();
                };
                const popHint = document.createElement('div');
                popHint.className = 'ntr-g-pop-hint';
                const popCountRow = document.createElement('div');
                popCountRow.className = 'ntr-g-pop-row';
                const labCount = document.createElement('span');
                labCount.textContent = '次数 ≥';
                labCount.title = '按出现次数（全文行数）过滤：低于该值的条目不显示、不写入；0 = 不过滤';
                const countInput = document.createElement('input');
                countInput.type = 'number';
                countInput.id = 'ntr-g-count-min';
                countInput.min = '0';
                countInput.step = '1';
                countInput.value = String(state.countMin);
                countInput.title = labCount.title;
                countInput.onchange = () => {
                    const v = Math.max(0, Math.floor(Number(countInput.value) || 0));
                    countInput.value = String(v);
                    state.countMin = v;
                    saveCountMin(v);
                    render();
                };
                const showFilteredCb = document.createElement('input');
                showFilteredCb.type = 'checkbox';
                showFilteredCb.id = 'ntr-g-show-filtered';
                const showFilteredLabel = document.createElement('label');
                showFilteredLabel.style.cssText = 'display:inline-flex;align-items:center;gap:4px;cursor:pointer;';
                const showFilteredTxt = document.createElement('span');
                showFilteredLabel.appendChild(showFilteredCb);
                showFilteredLabel.appendChild(showFilteredTxt);
                showFilteredCb.onchange = () => { state.showFiltered = showFilteredCb.checked; render(); };
                popCountRow.appendChild(labCount);
                popCountRow.appendChild(countInput);
                popCountRow.appendChild(showFilteredLabel);
                popover.appendChild(popCountRow);
                popover.appendChild(popHint);

                // 再次筛选（LLM 审计）：只打标签，删不删由用户决定
                const popSep1 = document.createElement('div');
                popSep1.className = 'ntr-g-pop-sep';
                popover.appendChild(popSep1);
                const popAuditTitle = document.createElement('div');
                popAuditTitle.className = 'ntr-g-pop-title';
                popAuditTitle.textContent = '再次筛选（把结果发给模型挑出多余的条目，只打标签，不删数据）';
                const auditBtn = document.createElement('button');
                auditBtn.className = 'ntr-g-btn';
                auditBtn.id = 'ntr-g-audit-btn';
                auditBtn.onclick = () => {
                    runAudit().catch((e) => NotificationUtils.showError(`筛选失败：${(e && e.message) || e}`));
                };
                const auditActions = document.createElement('div');
                auditActions.className = 'ntr-g-pop-row';
                const auditPickNone = document.createElement('button');
                auditPickNone.className = 'ntr-g-btn';
                auditPickNone.id = 'ntr-g-audit-none';
                auditPickNone.onclick = () => {
                    pushHistory();
                    auditRows().forEach((r) => state.selected.delete(r._index));
                    render();
                };
                const auditPickAll = document.createElement('button');
                auditPickAll.className = 'ntr-g-btn';
                auditPickAll.id = 'ntr-g-audit-all';
                auditPickAll.onclick = () => {
                    pushHistory();
                    auditRows().forEach((r) => { if (r.status !== 'existing') state.selected.add(r._index); });
                    render();
                };
                auditActions.appendChild(auditPickNone);
                auditActions.appendChild(auditPickAll);
                popover.appendChild(popAuditTitle);
                popover.appendChild(auditBtn);
                popover.appendChild(auditActions);
                const auditNoteEl = document.createElement('div');
                auditNoteEl.className = 'ntr-g-pop-hint';
                auditNoteEl.id = 'ntr-g-audit-note';
                popover.appendChild(auditNoteEl);

                // 撤销
                const popSep2 = document.createElement('div');
                popSep2.className = 'ntr-g-pop-sep';
                const undoRow = document.createElement('div');
                undoRow.className = 'ntr-g-pop-row';
                const undoBtn = document.createElement('button');
                undoBtn.className = 'ntr-g-btn';
                undoBtn.id = 'ntr-g-undo-btn';
                undoBtn.textContent = '↩ 撤销上一步';
                undoBtn.title = '回退最近一次勾选/标记改动（最多 30 步）';
                undoBtn.onclick = () => { if (undo()) render(); };
                const undoAuditBtn = document.createElement('button');
                undoAuditBtn.className = 'ntr-g-btn';
                undoAuditBtn.id = 'ntr-g-undo-audit-btn';
                undoAuditBtn.textContent = '撤销清洗';
                undoAuditBtn.title = '清掉「建议删」标记，并把勾选恢复成筛选前的样子';
                undoAuditBtn.onclick = () => {
                    pushHistory();
                    if (state.auditBaseline) restoreSnapshot(state.auditBaseline);
                    else rows.forEach((row) => delete row.audit);
                    state.auditBaseline = null;
                    state.auditNote = '已撤销清洗：标记已清除，勾选已恢复';
                    render();
                };
                undoRow.appendChild(undoBtn);
                undoRow.appendChild(undoAuditBtn);
                popover.appendChild(popSep2);
                popover.appendChild(undoRow);

                btnFilter.onclick = () => setPopoverOpen(popover.style.display === 'none');
                const closePopover = (e) => {
                    if (!overlay.isConnected) { document.removeEventListener('mousedown', closePopover); return; }
                    if (popover.style.display === 'none') return;
                    if (popover.contains(e.target) || btnFilter.contains(e.target)) return;
                    setPopoverOpen(false);
                };
                const onKeydown = (e) => {
                    if (!overlay.isConnected) { document.removeEventListener('keydown', onKeydown); return; }
                    if (e.key === 'Escape' && popover.style.display !== 'none') setPopoverOpen(false);
                };
                document.addEventListener('mousedown', closePopover);
                document.addEventListener('keydown', onKeydown);

                syncFilterPanel = () => {
                    const low = lowCountRows();
                    const noCount = rows.filter((r) => typeof r.count !== 'number').length;
                    const marks = auditRows();
                    const auditable = rows.filter((r) => r.status !== 'existing').length;
                    const batches = Math.max(1, Math.ceil(auditable / AUDIT_BATCH_SIZE));
                    // 按钮
                    btnFilter.textContent = (popover.style.display === 'none' ? '筛选 ▾' : '筛选 ▴') + (state.countMin > 0 ? ' ●' : '');
                    btnFilter.classList.toggle('on', state.countMin > 0);
                    btnFilter.title = state.countMin > 0
                        ? `次数≥${state.countMin}：已隐藏 ${low.length} 行（不写入、不导出）`
                        : '次数过滤 / 再次筛选 / 撤销';
                    // 面板
                    showFilteredTxt.textContent = `显示被过滤的（${low.length}）`;
                    showFilteredCb.disabled = state.countMin === 0;
                    const hintParts = [];
                    hintParts.push(state.countMin > 0 ? `已隐藏 ${low.length} 条（次数 < ${state.countMin}）` : '当前未按次数过滤');
                    if (noCount > 0) hintParts.push(`${noCount} 条无次数信息，不参与过滤`);
                    popHint.textContent = hintParts.join('；');
                    auditBtn.disabled = !onAudit || state.auditBusy;
                    auditBtn.textContent = state.auditBusy
                        ? '筛选中…'
                        : `再次筛选术语表（${batches} 个请求）`;
                    auditBtn.title = onAudit
                        ? `把 ${auditable} 条发给模型判废，只打「建议删」标签，不删除任何条目（失败则保持原样）`
                        : '当前入口没有可用的翻译器，无法筛选';
                    auditActions.style.display = marks.length > 0 ? 'flex' : 'none';
                    auditPickNone.textContent = `取消勾选建议删 (${marks.length})`;
                    auditPickAll.textContent = `勾选建议删 (${marks.length})`;
                    auditNoteEl.textContent = state.auditNote || '';
                    auditNoteEl.style.display = state.auditNote ? 'block' : 'none';
                    undoBtn.disabled = state.history.length === 0;
                    undoBtn.title = state.history.length > 0 ? `回退最近一次改动（可退 ${state.history.length} 步）` : '没有可撤销的改动';
                    undoAuditBtn.style.display = marks.length > 0 ? 'inline-block' : 'none';
                    if (auditTab) {
                        auditTab.style.display = marks.length > 0 ? 'inline-block' : 'none';
                        auditTab.textContent = `建议删 (${marks.length})`;
                    }
                };
            }

            card.appendChild(toolbar);

            // 类型复选框那一行（勾选/取消该类型在当前页签+搜索下可见的所有行）
            const typesBar = document.createElement('div');
            typesBar.className = 'ntr-g-types';
            typesBar.id = 'ntr-g-types';
            card.appendChild(typesBar);
            const typeChecks = new Map();   // type -> { cb, count }
            const rowSelectable = (row) => row.status === 'add' || row.status === 'conflict' || row.status === 'same';
            const syncTypeChecks = () => {
                typeChecks.forEach((info, type) => {
                    const visible = selectableRows().filter((r) => (r.type || '') === type);
                    const sel = visible.filter((r) => state.selected.has(r._index)).length;
                    info.cb.checked = visible.length > 0 && sel === visible.length;
                    info.cb.indeterminate = sel > 0 && sel < visible.length;
                    // 当前页签/搜索/次数过滤把该类型收窄时，显示「可见/总数」而不是只显示总数
                    const name = type || '（无类型）';
                    info.txt.textContent = visible.length === info.count ? `${name} ${info.count}` : `${name} ${visible.length}/${info.count}`;
                });
            };
            const buildTypeChecks = () => {
                typesBar.innerHTML = '';
                typeChecks.clear();
                if (mode !== 'merge') return;
                const counts = new Map();
                rows.forEach((row) => {
                    if (row.status === 'existing') return;      // 仅已有的行没有类型
                    const t = row.type || '';
                    counts.set(t, (counts.get(t) || 0) + 1);
                });
                if (counts.size === 0) return;
                const lead = document.createElement('span');
                lead.className = 'ntr-g-types-lead';
                lead.textContent = '类型：';
                typesBar.appendChild(lead);
                Array.from(counts.entries())
                    .sort((a, b) => (b[1] - a[1]) || String(a[0]).localeCompare(String(b[0]), 'ja'))
                    .forEach(([type, count]) => {
                        const item = document.createElement('label');
                        item.className = 'ntr-g-type-item';
                        item.title = `勾选/取消「${type || '（无类型）'}」的条目（只影响当前页签/搜索下可见的行）`;
                        const cb = document.createElement('input');
                        cb.type = 'checkbox';
                        cb.dataset.type = type;
                        const txt = document.createElement('span');
                        txt.textContent = `${type || '（无类型）'} ${count}`;
                        cb.onchange = () => {
                            pushHistory();
                            selectableRows().forEach((r) => {
                                if ((r.type || '') !== type) return;
                                if (cb.checked) state.selected.add(r._index);
                                else state.selected.delete(r._index);
                            });
                            render();
                        };
                        item.appendChild(cb);
                        item.appendChild(txt);
                        typesBar.appendChild(item);
                        typeChecks.set(type, { cb, txt, count });
                    });
                const allBtn = document.createElement('button');
                allBtn.className = 'ntr-g-btn';
                allBtn.textContent = '各类型全选';
                allBtn.onclick = () => { pushHistory(); selectableRows().forEach((r) => { if (rowSelectable(r)) state.selected.add(r._index); }); render(); };
                const noneBtn = document.createElement('button');
                noneBtn.className = 'ntr-g-btn';
                noneBtn.textContent = '各类型全不选';
                noneBtn.onclick = () => { pushHistory(); selectableRows().forEach((r) => state.selected.delete(r._index)); render(); };
                typesBar.appendChild(allBtn);
                typesBar.appendChild(noneBtn);
            };
            rebuildTypes = buildTypeChecks;
            buildTypeChecks();

            // 表格
            const body = document.createElement('div');
            body.className = 'ntr-g-body';
            const table = document.createElement('table');
            const thead = document.createElement('thead');
            // 快照是纯术语表（没有 次数/类型），restore 模式不显示这两列
            const headCb = document.createElement('input');
            headCb.type = 'checkbox';
            const columnDefs = [
                ...(mode === 'merge' ? [{ key: '', label: '', width: '34px', node: headCb }] : []),
                { key: 'src', label: '原文', width: '26%' },
                { key: 'dst', label: mode === 'restore' ? '版本译文' : '提取译文', width: '22%' },
                ...(mode === 'restore' ? [] : [{ key: 'count', label: '次数', width: '60px' }, { key: 'type', label: '类型', width: '110px' }]),
                { key: 'existing', label: mode === 'restore' ? '当前译文' : '现有译文', width: mode === 'restore' ? '30%' : '22%' },
                { key: 'status', label: '状态', width: '90px' },
            ];
            const sortMarks = {};
            const headRow = document.createElement('tr');
            columnDefs.forEach((def) => {
                const th = document.createElement('th');
                th.style.width = def.width;
                if (def.node) {
                    th.appendChild(def.node);
                } else {
                    const label = document.createElement('span');
                    label.textContent = def.label;
                    th.appendChild(label);
                    const mark = document.createElement('span');
                    mark.className = 'ntr-g-sort-mark';
                    th.appendChild(mark);
                    th.classList.add('ntr-g-sortable');
                    th.title = `点击按「${def.label}」排序（再点一次反向）；点第三次回到原始顺序`;
                    th.onclick = () => {
                        if (state.sortKey !== def.key) { state.sortKey = def.key; state.sortDir = 1; }
                        else if (state.sortDir === 1) { state.sortDir = -1; }
                        else { state.sortKey = ''; state.sortDir = 1; }
                        render();
                    };
                    sortMarks[def.key] = mark;
                }
                headRow.appendChild(th);
            });
            thead.appendChild(headRow);
            const tbody = document.createElement('tbody');
            table.appendChild(thead);
            table.appendChild(tbody);
            body.appendChild(table);
            card.appendChild(body);

            // 底部
            const foot = document.createElement('div');
            foot.className = 'ntr-g-foot';
            const warn = document.createElement('div');
            warn.className = 'ntr-g-warn';
            const btnCopy = document.createElement('button');
            btnCopy.className = 'ntr-g-btn';
            btnCopy.textContent = '复制 JSON';
            const btnDownload = document.createElement('button');
            btnDownload.className = 'ntr-g-btn';
            btnDownload.textContent = '下载 JSON';
            const btnClose = document.createElement('button');
            btnClose.className = 'ntr-g-btn';
            btnClose.textContent = '关闭';
            btnClose.onclick = () => overlay.remove();
            foot.appendChild(warn);
            foot.appendChild(btnCopy);
            foot.appendChild(btnDownload);
            if (mode === 'merge') {
                const btnWrite = document.createElement('button');
                btnWrite.className = 'ntr-g-btn primary';
                btnWrite.textContent = '合并写入';
                btnWrite.onclick = async () => {
                    const picked = buildResultRows();
                    if (picked.length === 0) {
                        NotificationUtils.showWarning('没有勾选任何条目');
                        return;
                    }
                    if (!confirm(`将写入 ${picked.length} 条术语到：${GlossaryTargets.describe(target)}\n\n注意：术语表变更会使已翻译章节标记为过期（需重翻）。\n确定写入吗？`)) return;
                    btnWrite.disabled = true;
                    try {
                        await onWrite(picked, rows);
                        NotificationUtils.showSuccess(`已写入 ${picked.length} 条术语`);
                        overlay.remove();
                    } catch (e) {
                        NotificationUtils.showError(`写入失败：${e.message || e}`);
                        btnWrite.disabled = false;
                    }
                };
                foot.appendChild(btnWrite);
            }
            if (mode === 'restore') {
                const btnRestore = document.createElement('button');
                btnRestore.className = 'ntr-g-btn danger';
                btnRestore.id = 'ntr-g-restore';
                btnRestore.textContent = '回滚到此版本';
                btnRestore.onclick = async () => {
                    const msg = `确认把 ${GlossaryTargets.describe(target)} 的术语表回滚到该版本？\n\n`
                        + `将新增 ${stats.add} 条、覆盖 ${stats.conflict} 条、删除 ${stats.existing} 条。\n`
                        + '注意：回滚会导致已翻译章节被标记为过期（需重翻）。';
                    if (confirmRestore && !confirm(msg)) return;
                    btnRestore.disabled = true;
                    try {
                        await onRestore();
                        overlay.remove();
                    } catch (e) {
                        NotificationUtils.showError(`回滚失败：${e.message || e}`);
                        btnRestore.disabled = false;
                    }
                };
                foot.appendChild(btnRestore);
            }
            foot.appendChild(btnClose);
            card.appendChild(foot);

            const sortValue = (row, key) => {
                if (key === 'src') return String(row.src || '');
                if (key === 'dst') return String(state.dsts[row._index] !== undefined ? state.dsts[row._index] : (row.dst || ''));
                if (key === 'count') return Number(row.count) || 0;
                if (key === 'type') return String(row.type || '');
                if (key === 'existing') {
                    if (mode === 'restore' && row.status === 'existing') return String(row.dst || '');
                    return row.existing === undefined ? '' : String(row.existing);
                }
                if (key === 'status') return ({ add: 0, conflict: 1, same: 2, existing: 3 })[row.status];
                return row._index;
            };
            const visibleRows = () => {
                const list = rows.filter((row) => {
                    if (state.filter === 'audit') { if (!row.audit) return false; }
                    else if (state.filter === 'suspect') { if (!(row.suspect && row.suspect.length)) return false; }
                    else if (state.filter !== 'all' && row.status !== state.filter) return false;
                    if (state.query) {
                        const q = state.query.toLowerCase();
                        if (!(row.src.toLowerCase().includes(q) || String(row.dst).toLowerCase().includes(q))) return false;
                    }
                    // 次数过滤：默认藏起来；勾了「显示被过滤的」才出现（灰色、不可勾选）
                    if (!state.showFiltered && isLowCount(row)) return false;
                    return true;
                });
                if (!state.sortKey) return list;
                const key = state.sortKey;
                const dir = state.sortDir === -1 ? -1 : 1;
                return list.slice().sort((a, b) => {
                    const va = sortValue(a, key);
                    const vb = sortValue(b, key);
                    let cmp = (typeof va === 'number' && typeof vb === 'number')
                        ? va - vb
                        : String(va).localeCompare(String(vb), 'ja');
                    if (cmp === 0) cmp = a._index - b._index;   // 同值保持原顺序
                    return cmp * dir;
                });
            };

            // 可勾选 = 可见且没被次数过滤掉（批量勾选、类型计数都用这个）
            const selectableRows = () => visibleRows().filter((row) => !isLowCount(row));

            const buildResultRows = () => {
                const picked = [];
                rows.forEach((row) => {
                    if (row.status === 'existing') return;
                    if (row.status === 'same') return;
                    if (row.status === 'conflict' && state.conflictPolicy === 'keep') return;
                    if (isLowCount(row)) return;   // 被次数过滤掉的不写入（双保险）
                    if (!state.selected.has(row._index)) return;
                    const dst = (state.dsts[row._index] || '').trim();
                    if (dst === '') return;
                    picked.push({ src: row.src, dst, type: row.type, status: row.status });
                });
                return picked;
            };

            const copyGlossary = () => {
                const g = {};
                rows.forEach((row) => {
                    if (row.status === 'existing') return;
                    if (row.status === 'same') { g[row.src] = row.dst; return; }
                    if (row.status === 'conflict' && state.conflictPolicy === 'keep') { g[row.src] = row.existing; return; }
                    if (isLowCount(row)) return;   // 复制/下载出来的就是表里看到的内容
                    const dst = (state.dsts[row._index] || '').trim();
                    if (dst !== '') g[row.src] = dst;
                });
                return g;
            };

            // 再次筛选（LLM 审计）：只打标签，删不删问用户
            const runAudit = async () => {
                if (!onAudit || state.auditBusy) return;
                const targets = rows.filter((row) => row.status !== 'existing');
                if (targets.length === 0) { NotificationUtils.showWarning('没有可筛选的条目'); return; }
                const batches = Math.max(1, Math.ceil(targets.length / AUDIT_BATCH_SIZE));
                const lanes = Math.max(1, Math.min(Number(auditConcurrency) || 1, batches));
                const par = lanes > 1 ? `，按「并发 ${lanes}」并行` : '';
                if (!confirm(`把 ${targets.length} 条术语发给模型筛一遍（${batches} 个请求${par}）？\n\n只会打「建议删」标签，不删除任何条目；筛完你再决定要不要取消勾选。`)) return;
                state.auditBaseline = snapshot();
                state.auditBusy = true;
                state.auditNote = `筛选中…（已完成 0/${batches} 批）`;
                render();
                try {
                    const res = await onAudit(targets, {
                        onProgress: (p) => {
                            const d = Number.isFinite(p.done) ? p.done : Math.min(p.batch, p.batches);
                            state.auditNote = `筛选中…（已完成 ${d}/${p.batches} 批）`;
                            syncFilterPanel();
                        },
                    }) || {};
                    const marks = res.marks instanceof Map ? res.marks : new Map();
                    let applied = 0;
                    rows.forEach((row) => {
                        if (row.status === 'existing') return;
                        if (marks.has(row.src)) { row.audit = marks.get(row.src); applied += 1; }
                        else delete row.audit;
                    });
                    const extra = [];
                    if (res.unmatched) extra.push(`${res.unmatched} 条未能匹配`);
                    if (res.failed) extra.push(`部分批次失败：${res.failed}`);
                    state.auditNote = applied > 0
                        ? `筛选完成：${applied} 条建议删${extra.length ? `（${extra.join('；')}）` : ''}`
                        : (res.failed ? `筛选失败：${res.failed}（未做任何改动）` : '筛选完成：没有发现多余条目');
                    state.auditBusy = false;
                    render();
                    if (applied > 0) {
                        const pct = Math.round((applied / targets.length) * 100);
                        const doUncheck = confirm(`筛选完成：${applied} / ${targets.length} 条疑似多余（${pct}%）。\n\n要把它们取消勾选吗？\n（只打标签不影响写入；事后可以用面板里的「撤销清洗」或「↩ 撤销上一步」回来）`);
                        if (doUncheck) {
                            pushHistory();
                            auditRows().forEach((row) => state.selected.delete(row._index));
                            state.auditNote += '；已取消勾选';
                        } else {
                            state.auditNote += '；只打标签';
                        }
                        render();
                    }
                } catch (e) {
                    if (state.auditBaseline) restoreSnapshot(state.auditBaseline);
                    state.auditBusy = false;
                    state.auditNote = `筛选失败：${(e && e.message) || e}（未做任何改动）`;
                    render();
                    throw e;
                }
            };

            const render = () => {
                const auditCount = auditRows().length;
                const suspectCount = rows.filter((r) => r.suspect && r.suspect.length).length;
                if (suspectTab) {
                    suspectTab.style.display = suspectCount > 0 ? '' : 'none';
                    suspectTab.textContent = `可疑 (${suspectCount})`;
                }
                statsEl.textContent = (mode === 'restore'
                    ? `版本 ${stats.total} 条 | 新增 ${stats.add} | 覆盖 ${stats.conflict} | 相同 ${stats.same} | 将删除 ${stats.existing}`
                    : (state.source ? `来源 ${state.source} | ` : '')
                        + `提取 ${stats.total} 条 | 新增 ${stats.add} | 冲突 ${stats.conflict} | 相同 ${stats.same} | 现有 ${stats.existing}`)
                    + (auditCount > 0 ? ` | 建议删 ${auditCount}` : '');
                tbody.innerHTML = '';
                Object.keys(sortMarks).forEach((k) => {
                    sortMarks[k].textContent = state.sortKey === k ? (state.sortDir === -1 ? '▼' : '▲') : '';
                });
                const list = visibleRows();
                const limit = 800;
                list.slice(0, limit).forEach((row) => {
                    const tr = document.createElement('tr');
                    const low = isLowCount(row);
                    tr.className = 'status-' + row.status + (low ? ' ntr-g-row-filtered' : '');
                    if (mode === 'merge') {
                        const td = document.createElement('td');
                        const cb = document.createElement('input');
                        cb.type = 'checkbox';
                        // 被次数过滤的行显示成"未勾选 + 禁用"：它无论如何都不会被写入
                        cb.checked = !low && state.selected.has(row._index);
                        if (low) {
                            cb.disabled = true;
                            cb.title = `次数 ${row.count} < ${state.countMin}：被次数过滤，不写入`;
                        }
                        cb.onchange = () => {
                            pushHistory();
                            if (cb.checked) state.selected.add(row._index);
                            else state.selected.delete(row._index);
                        };
                        td.appendChild(cb);
                        tr.appendChild(td);
                    }
                    const tdSrc = document.createElement('td');
                    tdSrc.textContent = row.src;
                    tdSrc.title = (row.context && row.context[0]) || '';
                    const tdDst = document.createElement('td');
                    if (mode === 'merge' && row.status !== 'existing') {
                        const input = document.createElement('input');
                        input.type = 'text';
                        input.value = state.dsts[row._index] || '';
                        input.style.width = '95%';
                        input.oninput = () => { state.dsts[row._index] = input.value; };
                        tdDst.appendChild(input);
                    } else if (mode === 'restore') {
                        // 「将删除」行：版本里没有这条，值只在「当前译文」列展示
                        tdDst.textContent = row.status === 'existing' ? '—' : row.dst;
                    } else {
                        tdDst.textContent = row.dst;
                    }
                    const tdCount = document.createElement('td');
                    tdCount.textContent = row.count;
                    const tdType = document.createElement('td');
                    tdType.textContent = row.type || '';
                    const tdExisting = document.createElement('td');
                    if (mode === 'restore') {
                        tdExisting.textContent = row.status === 'existing'
                            ? row.dst
                            : (row.existing === undefined ? '—' : row.existing);
                    } else {
                        tdExisting.textContent = row.existing === undefined ? '—' : row.existing;
                    }
                    const tdStatus = document.createElement('td');
                    const badge = document.createElement('span');
                    const labelMap = mode === 'restore'
                        ? { add: '新增', conflict: '覆盖', same: '相同', existing: '将删除' }
                        : { add: '新增', conflict: '冲突', same: '相同', existing: '仅已有' };
                    badge.className = 'ntr-g-badge ' + row.status;
                    badge.textContent = labelMap[row.status] || row.status;
                    tdStatus.appendChild(badge);
                    if (row.audit) {
                        const ab = document.createElement('span');
                        ab.className = 'ntr-g-badge audit';
                        ab.textContent = '建议删';
                        ab.style.marginLeft = '4px';
                        ab.title = `模型建议删：${auditTitle(row.audit)}`;
                        tdStatus.appendChild(ab);
                    }
                    if (row.suspect && row.suspect.length) {
                        const sb = document.createElement('span');
                        sb.className = 'ntr-g-badge suspect';
                        sb.textContent = '可疑';
                        sb.style.marginLeft = '4px';
                        sb.title = `按《术语表使用指南》值得看一眼：${row.suspect.join(' / ')}`;
                        tdStatus.appendChild(sb);
                    }
                    if (low) {
                        const lb = document.createElement('span');
                        lb.className = 'ntr-g-badge lowcount';
                        lb.textContent = '低次';
                        lb.style.marginLeft = '4px';
                        lb.title = `出现 ${row.count} 次 < ${state.countMin}：被次数过滤，不写入`;
                        tdStatus.appendChild(lb);
                    }
                    if (row.partial) {
                        const pb = document.createElement('span');
                        pb.className = 'ntr-g-badge partial';
                        pb.textContent = '截断';
                        pb.style.marginLeft = '4px';
                        tdStatus.appendChild(pb);
                    }
                    tr.appendChild(tdSrc);
                    tr.appendChild(tdDst);
                    if (mode !== 'restore') {
                        tr.appendChild(tdCount);
                        tr.appendChild(tdType);
                    }
                    tr.appendChild(tdExisting);
                    tr.appendChild(tdStatus);
                    tbody.appendChild(tr);
                });
                if (list.length > limit) {
                    const tr = document.createElement('tr');
                    const td = document.createElement('td');
                    td.colSpan = 7;
                    td.textContent = `另有 ${list.length - limit} 条未显示（请用搜索/筛选缩小范围）`;
                    td.style.color = '#888';
                    tr.appendChild(td);
                    tbody.appendChild(tr);
                }
                if (mode === 'merge') {
                    const picked = buildResultRows();
                    const willExpire = stats.add + stats.conflict;
                    const filteredNote = state.countMin > 0 ? `（已按次数≥${state.countMin} 过滤 ${lowCountRows().length} 条）` : '';
                    warn.innerHTML = (rows.length === 0 && enableImport)
                        ? '还没有条目：点右上角「选择 JSON 文件」，或把 .json 文件直接拖进这个窗口。'
                        : `写入预估：${picked.length} 条${filteredNote}；术语表变更后，已翻译章节将被标记为过期（涉及新增/冲突 ${willExpire} 条）。`;
                } else if (mode === 'restore') {
                    warn.textContent = (stats.add + stats.conflict + stats.existing) === 0
                        ? '该版本与当前术语表没有差异，回滚不会产生任何变更。'
                        : `回滚预估：新增 ${stats.add} 条、覆盖 ${stats.conflict} 条、删除 ${stats.existing} 条；`
                            + `回滚后已翻译章节将被标记为过期（涉及变更 ${stats.add + stats.conflict + stats.existing} 条）。`;
                } else {
                    warn.textContent = '预览模式：不会写入任何数据（合并写入将在后续版本启用）。';
                }
                if (mode === 'merge') {
                    const headCb = thead.querySelector('input[type=checkbox]');
                    if (headCb) {
                        headCb.onchange = () => {
                            pushHistory();
                            selectableRows().forEach((r) => {
                                if (headCb.checked) state.selected.add(r._index);
                                else state.selected.delete(r._index);
                            });
                            render();
                        };
                        const vis = selectableRows();
                        const selCount = vis.filter((r) => state.selected.has(r._index)).length;
                        headCb.checked = vis.length > 0 && selCount === vis.length;
                        headCb.indeterminate = selCount > 0 && selCount < vis.length;
                    }
                    syncTypeChecks();
                }
                syncFilterPanel();
            };

            // 从文件载入（选择按钮与拖拽共用这一段；解析走和文本框/剪贴板同一个 parseGlossaryEntries）
            const applyImportedText = (text, label) => {
                const imported = parseGlossaryEntries(text);
                if (imported.length === 0) {
                    NotificationUtils.showWarning(`${label} 里没有解析到术语（支持 KWG output.json 数组 / 扁平 JSON / 原文 => 译文 行）`);
                    return;
                }
                state.source = label || '';
                state.filter = 'all';
                state.query = '';
                searchInput.value = '';
                Object.keys(tabEls).forEach((k) => tabEls[k].classList.toggle('active', k === 'all'));
                setEntries(imported);
                // 标题里的条数是打开弹层时算的，换来源（选文件/拖拽）后要跟着更新
                titleEl.textContent = title.replace(/（\d+ 条）$/, `（${imported.length} 条）`);
                render();
                NotificationUtils.showSuccess(`已从 ${label} 载入 ${imported.length} 条术语`);
            };

            const pickFile = () => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json,.txt,application/json,text/plain';
                input.onchange = async () => {
                    const file = input.files && input.files[0];
                    if (!file) return;
                    try {
                        applyImportedText(await file.text(), file.name);
                    } catch (err) {
                        NotificationUtils.showError(`读取文件失败：${err.message || err}`);
                    }
                };
                input.click();
            };

            if (enableImport) {
                const setDropHint = (on) => {
                    card.style.outline = on ? '2px dashed #6ee7b7' : '';
                    card.style.outlineOffset = on ? '-6px' : '';
                };
                card.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setDropHint(true); });
                card.addEventListener('dragleave', (e) => { if (e.target === card) setDropHint(false); });
                card.addEventListener('drop', async (e) => {
                    e.preventDefault();
                    setDropHint(false);
                    const file = e.dataTransfer.files && e.dataTransfer.files[0];
                    if (!file) return;
                    try {
                        applyImportedText(await file.text(), file.name);
                    } catch (err) {
                        NotificationUtils.showError(`读取文件失败：${err.message || err}`);
                    }
                });
            }

            btnCopy.onclick = () => copyText(fmtText(copyGlossary()));
            btnDownload.onclick = () => downloadText(`glossary.${Date.now()}.json`, fmtJson(copyGlossary()));

            render();
            document.body.appendChild(overlay);
            return { overlay, render };
        };

        // 简易选择器（本地卷列表等）
        const pick = ({ title, options, renderOption }) => new Promise((resolve) => {
            ensureStyles();
            const overlay = document.createElement('div');
            overlay.id = 'ntr-glossary-overlay';
            overlay.className = 'ntr-g-overlay';
            const card = document.createElement('div');
            card.className = 'ntr-g-card';
            card.style.height = 'auto';
            card.style.maxHeight = '80vh';
            card.style.width = 'min(680px, 94vw)';
            const head = document.createElement('div');
            head.className = 'ntr-g-head';
            head.innerHTML = `<div class="ntr-g-title">${title}</div>`;
            const body = document.createElement('div');
            body.className = 'ntr-g-body';
            body.style.padding = '10px 14px';
            (options || []).forEach((opt) => {
                const row = document.createElement('div');
                row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:6px 0;border-bottom:1px solid #262626;';
                const label = document.createElement('div');
                label.style.cssText = 'flex:1;font-size:13px;';
                label.textContent = renderOption ? renderOption(opt) : String(opt);
                const btn = document.createElement('button');
                btn.className = 'ntr-g-btn';
                btn.textContent = '选择';
                btn.onclick = () => { overlay.remove(); resolve(opt); };
                row.appendChild(label);
                row.appendChild(btn);
                body.appendChild(row);
            });
            if (!options || options.length === 0) {
                body.innerHTML = '<div style="color:#888;font-size:13px;">没有可选条目</div>';
            }
            const foot = document.createElement('div');
            foot.className = 'ntr-g-foot';
            const btnCancel = document.createElement('button');
            btnCancel.className = 'ntr-g-btn';
            btnCancel.textContent = '取消';
            btnCancel.onclick = () => { overlay.remove(); resolve(undefined); };
            foot.appendChild(btnCancel);
            card.appendChild(head);
            card.appendChild(body);
            card.appendChild(foot);
            overlay.appendChild(card);
            document.body.appendChild(overlay);
        });

        return { open, status, pick, computeDiff, fmtText, fmtJson, copyText, downloadText, ensureStyles };
    })();
    // ==GlossaryUI-END==

    // ==GlossaryReport-START==
    // 验收回扫报告面板：只做展示/筛选/导出，不做任何写入
    const GlossaryReport = (() => {
        const CSS_ID = 'ntr-glossary-report-css';
        // 排序：问题优先——未落地 > 原文未见 > 不可检 > 已落地，同组按原文命中数降序
        const STATUS_ORDER = { missed: 0, absent: 1, unchecked: 2, landed: 3 };
        const STATUS_LABEL = { missed: '未落地', absent: '原文未见', unchecked: '不可检', landed: '已落地' };
        const STATUS_BADGE = { missed: 'missed', absent: 'absent', unchecked: 'unchecked', landed: 'landed' };

        const ensureStyles = () => {
            if (document.getElementById(CSS_ID)) return;
            const style = document.createElement('style');
            style.id = CSS_ID;
            style.textContent = `
.ntr-g-overlay tr.status-missed td:first-child { box-shadow: inset 3px 0 0 #d0a020; }
.ntr-g-overlay tr.status-absent td:first-child { box-shadow: inset 3px 0 0 #555; }
.ntr-g-overlay tr.status-unchecked td:first-child { box-shadow: inset 3px 0 0 #3860a0; }
.ntr-g-overlay tr.status-landed td:first-child { box-shadow: inset 3px 0 0 #3f9f3f; }
.ntr-g-overlay .ntr-g-badge.missed { background: #5A4A1E; color: #FEC; }
.ntr-g-overlay .ntr-g-badge.landed { background: #2E5A2E; color: #CFC; }
.ntr-g-overlay .ntr-g-badge.absent { background: #333; color: #AAA; }
.ntr-g-overlay .ntr-g-badge.unchecked { background: #24384F; color: #CDF; }
.ntr-g-overlay .ntr-g-rate { color: #8FD08F; font-weight: bold; }
.ntr-g-overlay td.ntr-g-num { text-align: right; color: #AAA; }
.ntr-g-overlay td.ntr-g-dim { color: #888; }
`;
            document.head.appendChild(style);
        };

        const sortRows = (rows) => rows.slice().sort((a, b) =>
            ((STATUS_ORDER[a.status] === undefined ? 9 : STATUS_ORDER[a.status]) - (STATUS_ORDER[b.status] === undefined ? 9 : STATUS_ORDER[b.status]))
            || (b.srcCount - a.srcCount) || String(a.src).localeCompare(String(b.src)));

        const filterRows = (rows, options) => {
            const filter = (options && options.filter) || 'all';
            const q = String((options && options.query) || '').trim().toLowerCase();
            return rows.filter((r) => {
                if (filter !== 'all' && r.status !== filter) return false;
                if (q === '') return true;
                return `${r.src}\n${r.dst}\n${r.info || ''}`.toLowerCase().includes(q);
            });
        };

        const formatRate = (rate) => `${(Math.max(0, Math.min(1, Number(rate) || 0)) * 100).toFixed(1)}%`;

        // TSV：给「导出当前列表」用，字段里的制表/换行剔掉
        const toTsv = (rows) => {
            const clean = (v) => String(v === undefined || v === null ? '' : v).replace(/[\t\r\n]+/g, ' ');
            const head = ['状态', '原文', '译文', '原文命中行数', '译文命中行数', '类型', '原文样例'];
            const body = rows.map((r) => [
                STATUS_LABEL[r.status] || r.status, r.src, r.dst, r.srcCount, r.dstCount, r.info || '', r.sample || '',
            ].map(clean).join('\t'));
            return [head.join('\t'), ...body].join('\n');
        };

        const open = ({ title, rows, stats, note, initialFilter = 'all' }) => {
            GlossaryUI.ensureStyles();
            ensureStyles();
            const old = document.getElementById('ntr-glossary-report-overlay');
            if (old) old.remove();

            const state = { filter: initialFilter, query: '' };
            const overlay = document.createElement('div');
            overlay.id = 'ntr-glossary-report-overlay';
            overlay.className = 'ntr-g-overlay';
            const card = document.createElement('div');
            card.className = 'ntr-g-card';
            overlay.appendChild(card);

            const head = document.createElement('div');
            head.className = 'ntr-g-head';
            const titleEl = document.createElement('div');
            titleEl.className = 'ntr-g-title';
            titleEl.textContent = title;
            const statsEl = document.createElement('div');
            statsEl.className = 'ntr-g-stats';
            head.appendChild(titleEl);
            head.appendChild(statsEl);
            if (note) {
                const noteEl = document.createElement('div');
                noteEl.className = 'ntr-g-warn';
                noteEl.textContent = note;
                head.appendChild(noteEl);
            }
            card.appendChild(head);

            const toolbar = document.createElement('div');
            toolbar.className = 'ntr-g-toolbar';
            const filterBtns = [];
            const mkFilter = (key, label) => {
                const b = document.createElement('button');
                b.className = 'ntr-g-tab';
                b.textContent = label;
                b.onclick = () => { state.filter = key; render(); };
                filterBtns.push({ key, el: b });
                toolbar.appendChild(b);
            };
            mkFilter('all', '全部');
            mkFilter('missed', '未落地');
            mkFilter('absent', '原文未见');
            mkFilter('unchecked', '不可检');
            mkFilter('landed', '已落地');
            const search = document.createElement('input');
            search.type = 'text';
            search.placeholder = '筛选原文/译文…';
            search.style.minWidth = '180px';
            search.oninput = () => { state.query = search.value; render(); };
            toolbar.appendChild(search);
            const mkBtn = (label, fn) => { const b = document.createElement('button'); b.className = 'ntr-g-btn'; b.textContent = label; b.onclick = fn; toolbar.appendChild(b); return b; };
            mkBtn('导出 TSV（当前列表）', () => GlossaryUI.downloadText(`验收回扫.${Date.now()}.tsv`, toTsv(filterRows(sortRows(rows), state))));
            mkBtn('复制未落地清单', () => GlossaryUI.copyText(rows.filter((r) => r.status === 'missed').map((r) => `${r.src} => ${r.dst}${r.info ? ' #' + r.info : ''}`).join('\n')));
            card.appendChild(toolbar);

            const body = document.createElement('div');
            body.className = 'ntr-g-body';
            card.appendChild(body);

            const foot = document.createElement('div');
            foot.className = 'ntr-g-foot';
            const closeBtn = document.createElement('button');
            closeBtn.className = 'ntr-g-btn primary';
            closeBtn.textContent = '关闭';
            closeBtn.onclick = () => overlay.remove();
            foot.appendChild(closeBtn);
            card.appendChild(foot);

            const RENDER_LIMIT = 2000; // 全量渲染在几千条时会卡，超出只渲染前 N 条（导出不受限）
            const render = () => {
                const list = filterRows(sortRows(rows), state);
                statsEl.innerHTML = '';
                const rateEl = document.createElement('span');
                rateEl.className = 'ntr-g-rate';
                rateEl.textContent = `落地率 ${formatRate(stats.rate)}`;
                statsEl.appendChild(rateEl);
                const detail = document.createElement('span');
                detail.textContent = `（可检 ${stats.checkable} / 共 ${stats.total} · 未落地 ${stats.missed} · 原文未见 ${stats.absent} · 不可检 ${stats.unchecked}）`;
                statsEl.appendChild(detail);
                filterBtns.forEach(({ key, el }) => el.classList.toggle('active', state.filter === key));
                body.innerHTML = '';
                const table = document.createElement('table');
                const thead = document.createElement('thead');
                const hr = document.createElement('tr');
                ['状态', '原文', '译文', '原/译命中', '类型', '原文样例'].forEach((h) => {
                    const th = document.createElement('th');
                    th.textContent = h;
                    hr.appendChild(th);
                });
                thead.appendChild(hr);
                table.appendChild(thead);
                const tbody = document.createElement('tbody');
                const mkTd = (text, cls, titleText) => {
                    const td = document.createElement('td');
                    if (cls) td.className = cls;
                    td.textContent = text;
                    if (titleText) td.title = titleText;
                    return td;
                };
                list.slice(0, RENDER_LIMIT).forEach((r) => {
                    const tr = document.createElement('tr');
                    tr.className = 'status-' + r.status;
                    const st = document.createElement('td');
                    const badge = document.createElement('span');
                    badge.className = 'ntr-g-badge ' + (STATUS_BADGE[r.status] || '');
                    badge.textContent = STATUS_LABEL[r.status] || r.status;
                    st.appendChild(badge);
                    tr.appendChild(st);
                    tr.appendChild(mkTd(r.src, '', r.sample || ''));
                    tr.appendChild(mkTd(r.dst, '', r.dstSample || ''));
                    tr.appendChild(mkTd(`${r.srcCount} / ${r.dstCount}`, 'ntr-g-num'));
                    tr.appendChild(mkTd(r.info || '', 'ntr-g-dim'));
                    tr.appendChild(mkTd(r.sample || '', 'ntr-g-dim'));
                    tbody.appendChild(tr);
                });
                table.appendChild(tbody);
                body.appendChild(table);
                if (list.length > RENDER_LIMIT) {
                    const hint = document.createElement('div');
                    hint.className = 'ntr-g-warn';
                    hint.style.padding = '8px 14px';
                    hint.textContent = `列表过长：仅渲染前 ${RENDER_LIMIT} 条（共 ${list.length} 条），导出 TSV 不受限`;
                    body.appendChild(hint);
                }
            };
            render();
            document.body.appendChild(overlay);
            return { close: () => overlay.remove(), rows: () => filterRows(sortRows(rows), state) };
        };

        return { open, toTsv, sortRows, filterRows, formatRate };
    })();
    // ==GlossaryReport-END==

    // ==GlossaryFix-START==
    // 修句审核面板：展示"现有译文 → 修正译文"，勾选后写回站点（写回动作由模块注入）
    const GlossaryFix = (() => {
        const CSS_ID = 'ntr-glossary-fix-css';
        const STATUS_LABEL = { changed: '可写回', applied: '已写回', unchanged: '无需修改', failed: '失败' };
        const STATUS_BADGE = { changed: 'conflict', applied: 'add', unchanged: 'same', failed: 'unchecked' };
        const ensureStyles = () => {
            if (document.getElementById(CSS_ID)) return;
            const style = document.createElement('style');
            style.id = CSS_ID;
            style.textContent = `
.ntr-g-overlay tr.status-changed td:first-child { box-shadow: inset 3px 0 0 #d0a020; }
.ntr-g-overlay tr.status-applied td:first-child { box-shadow: inset 3px 0 0 #3f9f3f; }
.ntr-g-overlay tr.status-unchanged td:first-child { box-shadow: inset 3px 0 0 #555; }
.ntr-g-overlay tr.status-failed td:first-child { box-shadow: inset 3px 0 0 #a04040; }
.ntr-g-overlay .ntr-g-badge.changed { background: #5A4A1E; color: #FEC; }
.ntr-g-overlay .ntr-g-badge.applied { background: #2E5A2E; color: #CFC; }
.ntr-g-overlay .ntr-g-badge.unchanged { background: #333; color: #AAA; }
.ntr-g-overlay .ntr-g-badge.failed { background: #5A2E2E; color: #FCC; }
.ntr-g-overlay td.ntr-g-clip { max-width: 300px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.ntr-g-overlay td.ntr-g-fixdiff { color: #9CD09C; }
`;
            document.head.appendChild(style);
        };

        const open = ({ title, note, rows, onApply }) => {
            GlossaryUI.ensureStyles();
            ensureStyles();
            const old = document.getElementById('ntr-glossary-fix-overlay');
            if (old) old.remove();
            const list = rows || [];
            const state = { selected: new Set(list.filter((r) => r.status === 'changed').map((r) => r.id)), busy: false };

            const overlay = document.createElement('div');
            overlay.id = 'ntr-glossary-fix-overlay';
            overlay.className = 'ntr-g-overlay';
            const card = document.createElement('div');
            card.className = 'ntr-g-card';
            overlay.appendChild(card);

            const head = document.createElement('div');
            head.className = 'ntr-g-head';
            const titleEl = document.createElement('div');
            titleEl.className = 'ntr-g-title';
            titleEl.textContent = title;
            const statsEl = document.createElement('div');
            statsEl.className = 'ntr-g-stats';
            head.appendChild(titleEl);
            head.appendChild(statsEl);
            if (note) {
                const noteEl = document.createElement('div');
                noteEl.className = 'ntr-g-warn';
                noteEl.textContent = note;
                head.appendChild(noteEl);
            }
            card.appendChild(head);

            const toolbar = document.createElement('div');
            toolbar.className = 'ntr-g-toolbar';
            const mkBtn = (label, fn) => { const b = document.createElement('button'); b.className = 'ntr-g-btn'; b.textContent = label; b.onclick = fn; toolbar.appendChild(b); return b; };
            mkBtn('全选可写回', () => { list.forEach((r) => { if (r.status === 'changed') state.selected.add(r.id); }); render(); });
            mkBtn('全不选', () => { state.selected.clear(); render(); });
            const applyBtn = mkBtn('写回选中', async () => {
                if (state.busy) return;
                const picked = list.filter((r) => state.selected.has(r.id) && r.status === 'changed');
                if (picked.length === 0) { NotificationUtils.showWarning('没有勾选可写回的段落'); return; }
                const chapterKeys = new Set(picked.map((r) => r.chapterKey || r.chapterTitle || ''));
                if (!window.confirm(`将写回 ${picked.length} 个段落到 ${chapterKeys.size} 个章节，直接更新站点译文。\n建议先确认这里没有站上正在跑的任务。\n\n继续？`)) return;
                state.busy = true; render();
                try {
                    const result = await onApply(picked.map((r) => r.id), (msg) => { const el = overlay.querySelector('#ntr-g-fix-progress'); if (el) el.textContent = msg; });
                    const applied = new Set(result.appliedIds || []);
                    const failedMap = new Map((result.failed || []).map((f) => [f.id, f.reason]));
                    list.forEach((r) => {
                        if (applied.has(r.id)) { r.status = 'applied'; state.selected.delete(r.id); }
                        else if (failedMap.has(r.id)) { r.status = 'failed'; r.error = failedMap.get(r.id); state.selected.delete(r.id); }
                    });
                    const okCount = (result.appliedIds || []).length;
                    const failCount = (result.failed || []).length;
                    if (failCount === 0) NotificationUtils.showSuccess(`已写回 ${okCount} 个段落`);
                    else NotificationUtils.showWarning(`写回完成：成功 ${okCount} / 失败 ${failCount}（失败项见状态列）`);
                } catch (e) {
                    NotificationUtils.showError(`写回失败：${(e && e.message) || e}`);
                } finally {
                    state.busy = false;
                    render();
                }
            });
            mkBtn('复制修正清单', () => GlossaryUI.copyText(list.filter((r) => r.status === 'changed' || r.status === 'applied').map((r) => `【${r.chapterTitle || ''}】\n${r.jp}\n- ${r.zh}\n+ ${r.after || ''}`).join('\n\n')));
            const progressEl = document.createElement('span');
            progressEl.id = 'ntr-g-fix-progress';
            progressEl.className = 'ntr-g-warn';
            toolbar.appendChild(progressEl);
            card.appendChild(toolbar);

            const body = document.createElement('div');
            body.className = 'ntr-g-body';
            card.appendChild(body);
            const foot = document.createElement('div');
            foot.className = 'ntr-g-foot';
            const closeBtn = document.createElement('button');
            closeBtn.className = 'ntr-g-btn primary';
            closeBtn.textContent = '关闭';
            closeBtn.onclick = () => overlay.remove();
            foot.appendChild(closeBtn);
            card.appendChild(foot);

            const render = () => {
                const by = (s) => list.filter((r) => r.status === s).length;
                statsEl.textContent = `共 ${list.length} 段 · 可写回 ${by('changed')} · 已写回 ${by('applied')} · 无需修改 ${by('unchanged')} · 失败 ${by('failed')} · 已勾选 ${state.selected.size}`;
                applyBtn.disabled = state.busy || state.selected.size === 0;
                applyBtn.textContent = state.busy ? '写回中…' : `写回选中（${state.selected.size}）`;
                body.innerHTML = '';
                const table = document.createElement('table');
                const thead = document.createElement('thead');
                const hr = document.createElement('tr');
                ['选', '状态', '章节', '原文', '现有译文', '修正后译文', '漏词'].forEach((h) => {
                    const th = document.createElement('th');
                    th.textContent = h;
                    hr.appendChild(th);
                });
                thead.appendChild(hr);
                table.appendChild(thead);
                const tbody = document.createElement('tbody');
                list.forEach((r) => {
                    const tr = document.createElement('tr');
                    tr.className = 'status-' + r.status;
                    const pick = document.createElement('td');
                    const box = document.createElement('input');
                    box.type = 'checkbox';
                    box.checked = state.selected.has(r.id);
                    box.disabled = r.status !== 'changed' || state.busy;
                    box.onchange = () => { if (box.checked) state.selected.add(r.id); else state.selected.delete(r.id); render(); };
                    pick.appendChild(box);
                    tr.appendChild(pick);
                    const st = document.createElement('td');
                    const badge = document.createElement('span');
                    badge.className = 'ntr-g-badge ' + (STATUS_BADGE[r.status] || '');
                    badge.textContent = STATUS_LABEL[r.status] || r.status;
                    if (r.status === 'failed' && r.error) badge.title = r.error;
                    st.appendChild(badge);
                    tr.appendChild(st);
                    const mkClip = (text, cls, titleText) => {
                        const td = document.createElement('td');
                        td.className = cls || 'ntr-g-clip';
                        td.textContent = text || '';
                        td.title = titleText || text || '';
                        return td;
                    };
                    tr.appendChild(mkClip(r.chapterTitle || '', 'ntr-g-clip'));
                    tr.appendChild(mkClip(r.jp));
                    tr.appendChild(mkClip(r.zh));
                    tr.appendChild(mkClip(r.after || '', 'ntr-g-clip ntr-g-fixdiff'));
                    tr.appendChild(mkClip((r.missed || []).map((m) => `${m.src} => ${m.dst}`).join('；')));
                    tbody.appendChild(tr);
                });
                table.appendChild(tbody);
                body.appendChild(table);
            };
            render();
            document.body.appendChild(overlay);
            return { close: () => overlay.remove(), rows: () => list };
        };

        return { open };
    })();
    // ==GlossaryFix-END==


    // -----------------------------------
    // Glossary Queue (持久化任务队列：IDB jobs + chunks 分块缓存，刷新后可续跑)
    // -----------------------------------
    const GlossaryQueue = (() => {
        let scriptRef = null;
        let loopActive = false;
        let stopRequested = false;
        let runningJobId = null;
        let panelRefresh = null;
        let glanceHook = null;   // 面板上「术语队列」行的速览角标（队列:X | 运行中:Y）
        // 进度预计：每个任务最近的完成时刻（只存内存，刷新后靠 job.progress 里的时间戳兜底）
        const rateTrack = new Map();   // jobId -> { round, base, samples: [{t, done}] }

        // 纯函数（便于单测）：progress = job.progress，samples = 最近几次 chunk-done 的时刻
        const etaFor = (progress, samples, now = Date.now()) => {
            if (!progress) return null;
            const total = Number(progress.totalChunks) || 0;
            const base = Number(progress.chunksBase) || 0;
            const done = Math.max(0, (Number(progress.chunksDone) || 0) - base);
            if (total <= 0 || done >= total) return null;
            const list = (samples || []).filter((s) => s && typeof s.t === 'number' && typeof s.done === 'number');
            let perMin = 0;
            if (list.length >= 2) {
                const dt = (list[list.length - 1].t - list[0].t) / 60000;
                const dd = list[list.length - 1].done - list[0].done;
                if (dt > 0.05 && dd > 0) perMin = dd / dt;
            } else if (progress.roundStartedAt) {
                const dt = (now - progress.roundStartedAt) / 60000;
                const since = Math.max(0, (Number(progress.chunksDone) || 0) - Math.max(base, Number(progress.timerBase) || 0));
                if (dt > 0.15 && since > 0) perMin = since / dt;
            }
            return { perMin, etaMs: perMin > 0 ? ((total - done) / perMin) * 60000 : null, done, total };
        };
        const fmtEta = (ms) => {
            if (ms === null || ms === undefined) return '';
            const min = Math.round(ms / 60000);
            if (min < 1) return '不到 1 分';
            if (min < 60) return `${min} 分`;
            return `${Math.floor(min / 60)} 小时 ${min % 60} 分`;
        };

        const notify = () => {
            if (panelRefresh) { try { panelRefresh(); } catch (e) { } }
            if (glanceHook) { try { glanceHook(); } catch (e) { } }
        };

        // ---------- 设置读取 ----------
        const readSettings = (moduleName, defaults) => {
            const mod = scriptRef && scriptRef.configuration.modules.find((m) => m.name === moduleName);
            const settings = (mod && mod.settings) || [];
            const out = {};
            Object.keys(defaults).forEach((key) => {
                const found = settings.find((s) => s.name === key);
                out[key] = found === undefined || found.value === '' || found.value === undefined ? defaults[key] : found.value;
            });
            return out;
        };

        // 提取参数（复用“AI提取术语表”模块的设置；入队时快照进 job.options）
        const extractSettings = () => {
            const o = readSettings('AI提取术语表', {
                '原文语言': 'JA',
                '分块字数': 3000,
                '输出上限': 0,
                '最大轮数': 3,
                '并发': 2,
                'RPM': 0,
                '逾时(秒)': 300,
                '行数上限': 0,
                '种子补漏': true,
                '种子轮数': 3,
                '证据核实': true,
                '翻译器': '',
                '使用临时端点': false,
                '临时端点': '',
                '临时模型': '',
                '临时Key': '',
            });
            return {
                sourceLanguage: o['原文语言'],
                budgetChars: Math.max(200, Number(o['分块字数']) || 3000),
                maxTokens: Math.max(0, Number(o['输出上限']) || 0),
                maxRounds: Math.max(1, Number(o['最大轮数']) || 3),
                concurrency: Math.max(1, Number(o['并发']) || 2),
                rpm: Math.max(0, Number(o['RPM']) || 0),
                timeoutMs: Math.max(5, Number(o['逾时(秒)']) || 300) * 1000,
                maxLines: Number(o['行数上限']) || 0,
                seedPolish: o['种子补漏'] !== false,
                maxSeedRounds: Math.max(1, Number(o['种子轮数']) || 3),
                verify: o['证据核实'] !== false,
                workerId: o['翻译器'] || '',
                testEndpoint: o['使用临时端点'] ? (o['临时端点'] || '') : '',
                testModel: o['临时模型'] || '',
                testKey: o['临时Key'] || '',
            };
        };

        // 运行类参数（并发/RPM/逾时）不走入队快照：每次执行都实时读「术语队列」设置里的覆盖
        // （右键「术语队列」→ 设置；0=跟随），没有覆盖时用「AI提取术语表」的当前值 ——
        // 长队列中途提速/放宽超时不用重新入队，已添加未跑完的任务下一次开跑即生效。
        // 分块字数/最大轮数/行数上限/翻译器仍是入队时固定的那份
        // （分块字数是分块缓存的键序依据，中途改会让旧缓存按序号错位复用）
        const jobRuntime = (options) => {
            const live = extractSettings();
            const base = options || live;
            const qs = queueSettings();
            const qConc = Math.max(0, Number(qs['并发(0=跟随)']) || 0);
            const qRpm = Math.max(0, Number(qs['RPM(0=跟随)']) || 0);
            const qTimeoutS = Math.max(0, Number(qs['逾时(秒,0=跟随)']) || 0);
            return {
                ...base,
                concurrency: qConc > 0 ? qConc : live.concurrency,
                rpm: qRpm > 0 ? qRpm : live.rpm,
                timeoutMs: qTimeoutS > 0 ? qTimeoutS * 1000 : live.timeoutMs,
            };
        };

        // 入队用的设置：和 extractSettings 一样读「AI提取术语表」，
        // 但若队列面板指定了「运行翻译器」，用指定值覆盖 workerId（面板设置总是领先于条目自带的）
        const extractSettingsWithRuntime = () => {
            const base = extractSettings();
            const ovr = readQueueRuntime();
            if (!ovr.workerId) return base;   // 跟随 AI 提取术语表 → 不动
            return { ...base, workerId: ovr.workerId };
        };

        const queueSettings = () => readSettings('术语队列', {
            '自动续跑': true,
            '自动确认纯新增': false,
            '保留已完成': 5,
            '收藏添加上限': 30,
            '并发(0=跟随)': 0,
            'RPM(0=跟随)': 0,
            '逾时(秒,0=跟随)': 0,
        });

        // 队列面板的「运行翻译器」覆盖：独立 localStorage 键，避免和「AI提取术语表」设置耦合
        // （默认跟随：workerId=''）。panel 改动会立即重写所有 pending 任务的 options.workerId
        // ——已经开始跑的（progress 已写 / running）按既有快照走，不再被覆盖
        const QUEUE_RUNTIME_KEY = 'ntr-queue-runtime';
        const readQueueRuntime = () => {
            try {
                const raw = localStorage.getItem(QUEUE_RUNTIME_KEY);
                const o = raw ? JSON.parse(raw) : {};
                return { workerId: typeof o.workerId === 'string' ? o.workerId : '' };
            } catch (e) { return { workerId: '' }; }
        };
        const writeQueueRuntime = async (patch) => {
            const cur = readQueueRuntime();
            const next = { ...cur, ...patch };
            localStorage.setItem(QUEUE_RUNTIME_KEY, JSON.stringify(next));
            // 改了面板选项 → 把所有"未跑完"的任务的 options.workerId 立刻对齐
            // 判定未跑完：state==='pending' / running / review / failed，且 progress.covered < progress.totalLines
            // （done：已写入完成，不动；已经覆盖全部的：剩下的 0 行，切了也没意义）
            const targetWorker = next.workerId;
            const live = extractSettings().workerId || '';
            const all = await list();
            for (const j of all) {
                if (!isJobOverridable(j)) continue;
                let changed = false;
                if (targetWorker) {
                    if (j.options.workerId !== targetWorker) { j.options.workerId = targetWorker; changed = true; }
                } else {
                    // 跟随 AI 提取术语表 → 清掉选项，让 executeJob 实时读
                    if ('workerId' in j.options && j.options.workerId !== live) { delete j.options.workerId; changed = true; }
                }
                if (changed) { await put(j); }
            }
            notify();
        };
        // "未跑完"判定：覆盖所有还可能再发请求的任务（写入完成的 done 永远不动）
        const isJobOverridable = (j) => {
            if (j.state === 'done') return false;
            if (j.state === 'pending') return true;
            const p = j.progress || {};
            if (!p.totalLines) return true;     // 没进度信息（fresh job）按可覆盖
            return Number(p.covered || 0) < Number(p.totalLines);
        };

        const resolveWorkers = async (options) => {
            if (options.testEndpoint) {
                if (!options.testModel) return [];   // 用临时端点时必须填模型
                return [{ id: '临时端点', model: options.testModel, endpoint: options.testEndpoint, key: options.testKey || 'no_key_required' }];
            }
            return readWorkspaceGptWorkers()
                .filter((w) => !options.workerId || w.id === options.workerId)
                .filter((w) => w.endpoint && w.model)
                .map((w) => ({ id: w.id, model: w.model, endpoint: w.endpoint, key: w.key }));
        };

        // ---------- 再次筛选（审计）：对已有结果跑一轮，把标记写回 job.entries ----------
        // 正在「再次筛选」的任务（内存态：审计跑在页面里、刷新即丢，和审计本身同生命周期）
        // → 面板徽章显示「待筛选」、该行「筛选」按钮禁用；结束（含报错）即恢复
        const auditingIds = new Set();
        const auditJob = async (id, { onProgress } = {}) => {
            if (auditingIds.has(id)) throw new Error('该任务正在筛选中');
            const job = await get(id);
            if (!job) throw new Error('任务不存在');
            if (!job.entries || job.entries.length === 0) throw new Error('任务还没有可以筛选的条目');
            auditingIds.add(id);
            notify();
            try {
                const options = jobRuntime(job.options);
                const workers = await resolveWorkers(options);
                if (!workers.length) throw new Error('没有可用的翻译器：任务入队时的「翻译器 / 临时端点」现在解析不到 worker');
                const requester = GlossaryEngine.createRequester(workers, {
                    timeoutMs: options.timeoutMs,
                    rpm: options.rpm,
                    maxTokens: 0,          // 审计同样不发送输出上限
                    temperature: 0,
                });
                const res = await GlossaryEngine.auditGlossary({
                    entries: job.entries,
                    call: (messages) => requester.call(messages),
                    context: { title: job.title || '' },
                    concurrency: options.concurrency,   // 实时读「并发」（jobRuntime）
                    onProgress,
                });
                GlossaryLog.info('再次筛选完成', {
                    id: job.id, entries: job.entries.length, batches: res.batches,
                    marks: res.marks.size, unmatched: res.unmatched, failed: res.failed || null,
                    concurrency: options.concurrency,
                });
                job.entries.forEach((e) => { delete e.audit; });   // 重跑就整批换新标记
                res.marks.forEach((mark, src) => {
                    const hit = job.entries.find((e) => e.src === src);
                    if (hit) hit.audit = mark;
                });
                job.auditAt = Date.now();
                await put(job);
                return res;
            } finally {
                auditingIds.delete(id);
                notify();
            }
        };

        // ---------- 任务 CRUD ----------
        const list = async () => (await GlossaryDB.getAll('jobs')).sort((a, b) => a.createAt - b.createAt);
        const get = (id) => GlossaryDB.get('jobs', id);
        // 面板速览角标用：队列（待处理）/ 运行中 / 待确认
        const counts = async () => {
            const jobs = await list();
            return {
                queued: jobs.filter((j) => j.state === 'pending').length,
                running: jobs.filter((j) => j.state === 'running').length,
                review: jobs.filter((j) => j.state === 'review').length,
            };
        };
        // 用户删掉的任务不许"复活"：跑着的任务会在每个分块结束时 put 回写，
        // 如果这期间用户点了「删除」，旧写法会把记录重新写回 IDB（还带着 running 状态，
        // 刷新页面又被「自动续跑」接管）——所以删除后要记住 id 并让后续 put 变成空操作
        const deletedIds = new Set();
        const put = (job) => {
            if (deletedIds.has(job.id)) return Promise.resolve();
            job.updateAt = Date.now();
            return GlossaryDB.put('jobs', job);
        };

        const purgeChunks = async (jobId) => {
            const chunks = await GlossaryDB.getAll('chunks');
            const prefix = 'job:' + jobId;
            for (const c of chunks) {
                if (String(c.id).startsWith(prefix)) await GlossaryDB.delete('chunks', c.id);
            }
        };

        // 该任务已成功跑过的分块缓存记录（含各自覆盖的正文行）
        // 用途：①「重试」只补没覆盖过的行；②行覆盖率（已覆盖 / 总行数）
        const jobChunkRecords = async (jobId) => {
            const chunks = await GlossaryDB.getAll('chunks');
            const prefix = 'job:' + jobId + '/';
            return chunks.filter((c) => String(c.id).startsWith(prefix));
        };

        const remove = async (id) => {
            deletedIds.add(id);
            if (runningJobId === id) stopRequested = true;   // 正在跑的：停在当前分块，别再往下走
            await GlossaryDB.delete('jobs', id);
            await purgeChunks(id);
            notify();
        };

        const addJobs = async (targets, options) => {
            const created = [];
            for (const target of targets) {
                const job = {
                    id: 'job_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7),
                    kind: target.kind,
                    target,
                    title: target.title || GlossaryTargets.describe(target),
                    state: 'pending',
                    createAt: Date.now(),
                    updateAt: Date.now(),
                    options,
                    entries: null,
                    resultCount: 0,
                    progress: null,
                    error: null,
                };
                await GlossaryDB.put('jobs', job);
                created.push(job);
            }
            notify();
            return created;
        };

        // ---------- 执行单个任务 ----------
        const executeJob = async (job) => {
            runningJobId = job.id;
            const jobT0 = Date.now();
            try {
                // 兜底：面板设置有"运行翻译器"时，任务未跑完（pending / running / review / failed 但还有没覆盖到的行）
                // 在跑这一刻也要用面板指定的 worker（写回 IDB 以便审计/日志里看到的是真实生效值）；
                // 已覆盖完成的任务已经发过请求了，缓存全有，不会再发，切了也没意义 → 不动
                const ovr = readQueueRuntime();
                if (ovr.workerId && isJobOverridable(job) && job.options.workerId !== ovr.workerId) {
                    job.options = { ...job.options, workerId: ovr.workerId };
                    await put(job);
                }

                job.state = 'running';
                job.error = null;
                await put(job); notify();
                GlossaryLog.info('任务开始', { id: job.id, title: job.title, target: job.target });

                const options = jobRuntime(job.options);
                const workers = await resolveWorkers(options);
                if (workers.length === 0) {
                    const wanted = (options.workerId || '').trim();
                    throw new Error(wanted
                        ? `没有可用的翻译器「${wanted}」（工作区里可能已删除或没填端点；可改选「全部（自动轮换）」）`
                        : '没有可用的翻译器（工作区 GPT，或「临时端点 + 临时模型」）');
                }

                let lastSyncAt = 0;
                const { text } = await loadGlossarySourceText(job.target, (msg) => {
                    job.progress = { ...(job.progress || {}), sync: msg };
                    if (Date.now() - lastSyncAt > 1000) {
                        lastSyncAt = Date.now();
                        put(job);
                        notify();
                    }
                });
                let lines = GlossaryEngine.splitLines(text)
                    .filter((line) => GlossaryEngine.languageFilter(line, options.sourceLanguage))
                    .filter((line) => !GlossaryEngine.ruleFilter(line));
                if (options.maxLines > 0) lines = lines.slice(0, options.maxLines);
                if (lines.length === 0) throw new Error('正文为空');

                // 只补未覆盖的行：已经成功跑过的块（分块缓存记录）覆盖过的行不再重发
                // （但要保证已有结果在手上，否则会丢掉那部分条目 → 那种情况退化成整本重跑）
                const records = await jobChunkRecords(job.id);
                const prevEntries = job.entries || [];
                const pendingAll = prevEntries.length > 0 ? GlossaryEngine.uncoveredLines(lines, records) : lines;
                const coveredBase = lines.length - pendingAll.length;
                // 补跑时块序号不再对应"书里的位置"：缓存键换到 /fill 子命名空间，
                // 免得覆盖掉整本那轮留下的记录（命中仍要过 linesMatch 核对，双保险）
                const cacheNamespace = 'job:' + job.id + (pendingAll.length < lines.length ? '/fill' : '');
                // 这次是"整本重来"还是"只补没覆盖的行"：整本跑会把整本缓存重写一遍
                // （决定 job.everFailed 是刷新还是延续："重跑到底还会不会发请求"看它）
                const isFullRun = pendingAll.length === lines.length;
                if (pendingAll.length === 0) {
                    job.state = 'review';
                    job.error = null;
                    job.progress = { ...(job.progress || {}), covered: lines.length, uncovered: 0, totalLines: lines.length, runLines: 0, sync: null };
                    await put(job); notify();
                    NotificationUtils.showSuccess(`《${job.title}》没有未处理的正文行（${lines.length} 行全部已覆盖）`);
                    return;
                }

                job.progress = {
                    round: 0, maxRounds: options.maxRounds, chunksDone: 0, chunksFailed: 0,
                    pendingLines: pendingAll.length, runLines: pendingAll.length, totalLines: lines.length,
                    coveredBase, covered: coveredBase, uncovered: lines.length - coveredBase,
                };
                if (isFullRun) job.everFailed = false;   // 整本缓存即将重写，历史失败标记作废
                await put(job); notify();

                const requester = GlossaryEngine.createRequester(workers, { timeoutMs: options.timeoutMs, rps: options.concurrency, rpm: options.rpm, maxTokens: options.maxTokens });
                let lastWrite = 0;
                const result = await GlossaryEngine.runJob({
                    lines: pendingAll,
                    callLLM: (messages) => requester.call(messages),
                    options: {
                        budgetChars: options.budgetChars,
                        maxRounds: options.maxRounds,
                        concurrency: options.concurrency,
                        targetLanguage: '中文',
                        seedPolish: options.seedPolish !== false,
                        maxSeedRounds: Math.max(1, Number(options.maxSeedRounds) || 3),
                        seedLedger: job.seedLedger || undefined,
                    },
                    shouldStop: () => stopRequested,
                    cache: {
                        namespace: cacheNamespace,
                        get: (key) => GlossaryDB.get('chunks', key),
                        // 任务被删掉后别再往 IDB 里写分块缓存（否则删除会留下孤儿记录）
                        put: (key, value) => (deletedIds.has(job.id) ? Promise.resolve() : GlossaryDB.put('chunks', { id: key, ...value })),
                    },
                    onProgress: (p) => {
                        const prev = job.progress || {};
                        // 收尾报告里 round 已经 +1，别把它当成"换了新的一轮"
                        const isDone = p.phase === 'done';
                        const isSeedPhase = String(p.phase || '').startsWith('seed-');
                        const roundChanged = !isDone && !isSeedPhase && prev.round !== p.round;
                        // 缓存命中是瞬时的：不参与计时（否则速度会被算得虚高），但不算"没完成"
                        const cachedReplay = p.phase === 'chunk-cached' || p.phase === 'seed-chunk-cached';
                        const timerReset = !isDone && (cachedReplay || p.phase === 'round-start' || roundChanged);
                        const roundStartedAt = timerReset ? Date.now() : (prev.roundStartedAt || Date.now());
                        const timerBase = timerReset ? (p.chunksDone || 0) : (prev.timerBase || 0);
                        const chunksBase = isDone ? (prev.chunksBase || 0)
                            : ((p.phase === 'round-start' || roundChanged) ? (p.chunksDone || 0) : (prev.chunksBase || 0));
                        // 行覆盖率：入队时用缓存记录算出的已覆盖基数 + 本轮成功块覆盖的行
                        // （注意 p.coveredLines 只统计本次要跑的那些行，所以基数是分开加的）
                        const coveredBase = Number(prev.coveredBase) || 0;
                        const covered = Math.min(lines.length, coveredBase + (Number(p.coveredLines) || 0));
                        job.progress = {
                            round: p.round, maxRounds: p.maxRounds, chunksDone: p.chunksDone,
                            chunksFailed: p.chunksFailed, pendingLines: p.pendingLines,
                            totalLines: lines.length, runLines: prev.runLines || lines.length,
                            coveredBase, covered, uncovered: lines.length - covered,
                            totalChunks: p.totalChunks || prev.totalChunks || 0,
                            chunksBase, timerBase, roundStartedAt,
                        };
                        // 速率采样：只留最近 5 个
                        const track = rateTrack.get(job.id) || { round: p.round, samples: [] };
                        if (track.round !== p.round || p.phase === 'round-start' || cachedReplay) {
                            track.round = p.round;
                            track.samples = [];
                        }
                        track.samples.push({ t: Date.now(), done: p.chunksDone || 0 });
                        if (track.samples.length > 5) track.samples.shift();
                        rateTrack.set(job.id, track);
                        const now = Date.now();
                        if (now - lastWrite > 800 || p.phase === 'done') {
                            lastWrite = now;
                            put(job).then(notify).catch(() => { });
                        }
                    },
                });

                // 只补未覆盖的行 → 结果要和已有条目合并：
                // 已有 src 保留（那部分正文没重跑），新补的条目按全书正文重新计数
                // （引擎只在"本次要跑的行"上统计次数，补跑会让次数偏小）
                // 证据化核实（可选）：只核实本次新提取的条目（已有条目在历史轮次核实过）
                let newEntries = result.glossary;
                let verifyStats = null;
                if (options.verify !== false && !stopRequested && newEntries.length > 0) {
                    verifyStats = await GlossaryEngine.verifyEntries({
                        entries: newEntries,
                        lines,
                        call: (messages) => requester.call(messages),
                        concurrency: options.concurrency,
                        shouldStop: () => stopRequested,
                        onProgress: (p) => GlossaryLog.debug('核实进度', p),
                    });
                    newEntries = verifyStats.entries.map((e) => (e.verifyDrop
                        ? { ...e, suspect: [...(e.suspect || []), `核实建议剔除${e.verified && e.verified.reason ? `：${e.verified.reason}` : ''}`] }
                        : e));
                    GlossaryLog.info('证据核实', {
                        id: job.id, checked: verifyStats.checked, kept: verifyStats.kept,
                        dropped: verifyStats.dropped, invalid: verifyStats.invalid, failedBatches: verifyStats.failedBatches,
                    });
                }
                job.seedLedger = result.seedLedger || null;
                job.boost = {
                    seedRounds: result.seedRounds || 0,
                    seedChunks: result.polishChunks || 0,
                    seedFailed: result.seedChunksFailed || 0,
                    verifyDrops: verifyStats ? verifyStats.dropped : 0,
                    verifyFailedBatches: verifyStats ? verifyStats.failedBatches : 0,
                };

                // 只补未覆盖的行 → 结果要和已有条目合并：
                // 已有 src 保留（那部分正文没重跑），新补的条目按全书正文重新计数
                // （引擎只在"本次要跑的行"上统计次数，补跑会让次数偏小）
                let merged = prevEntries.slice();
                const added = newEntries.filter((e) => !merged.some((prev) => prev.src === e.src));
                if (added.length > 0) merged = merged.concat(added);
                if (merged.length > 0) merged = GlossaryEngine.searchForContext(merged, lines);

                job.entries = merged;
                job.resultCount = merged.length;

                const coveredAfter = Math.min(lines.length, coveredBase + (result.processedLines || []).length);
                const uncoveredAfter = lines.length - coveredAfter;
                job.progress = {
                    ...job.progress,
                    pendingLines: result.pendingLines,
                    covered: coveredAfter, uncovered: uncoveredAfter, totalLines: lines.length,
                };
                // 「重跑会不会真的发请求」的历史标记：只要整本缓存可能不全（块失败过 / 有行始终没跑到），
                // 以后的「重跑」就还有活干，必须给真按钮；补跑不刷新它（/fill 修不了整本命名空间的窟窿）
                const hadFail = Number(job.progress.chunksFailed) > 0 || uncoveredAfter > 0;
                job.everFailed = isFullRun ? hadFail : (job.everFailed === true || hadFail);

                if (stopRequested) {
                    job.state = 'pending';
                    job.error = uncoveredAfter > 0
                        ? `已停止（还剩 ${uncoveredAfter} 行没跑；已跑过的分块已缓存，可继续）`
                        : '已停止（已跑过的分块已缓存，可继续）';
                } else if (merged.length === 0) {
                    job.state = 'failed';
                    job.error = uncoveredAfter > 0 ? `${uncoveredAfter} 行全部提取失败` : '没有提取到术语';
                } else {
                    job.error = uncoveredAfter > 0 ? `${uncoveredAfter} 行未能提取（已保留其余结果）` : null;
                    const qs = queueSettings();
                    let autoWritten = false;
                    if (qs['自动确认纯新增']) {
                        const existing = await GlossaryTargets.loadGlossary(job.target);
                        // 核实建议剔除的条目不参与自动写入（保留在任务里供人工复核）
                        const candidates = merged.filter((e) => !e.verifyDrop);
                        const verifyDropped = merged.length - candidates.length;
                        const { stats } = GlossaryUI.computeDiff(candidates, existing);
                        // 指南门槛：全部条目通过零成本检查（无形态可疑、非改原文）才允许免审写入；否则留在「待确认」
                        const guideBlocked = candidates.filter((e) => e.partial
                            || GlossaryEngine.suspectReasons(e.src).length > 0
                            || GlossaryEngine.looksLikeSourceTampering(e.src));
                        if (stats.conflict === 0 && stats.same === 0 && stats.add > 0 && guideBlocked.length === 0) {
                            const picked = candidates.filter((e) => !e.partial).map((e) => ({ src: e.src, dst: e.dst, type: e.type }));
                            if (picked.length > 0) {
                                await writeGlossaryMerged(job.target, picked);
                                autoWritten = true;
                                if (verifyDropped > 0) GlossaryLog.info('自动确认：核实剔除条目不写入', { id: job.id, dropped: verifyDropped });
                            }
                        } else if (guideBlocked.length > 0) {
                            GlossaryLog.info('自动确认被指南门槛拦下，转人工确认', {
                                id: job.id, blocked: guideBlocked.length,
                                samples: guideBlocked.slice(0, 5).map((e) => e.src),
                            });
                        }
                    }
                    job.state = autoWritten ? 'done' : 'review';
                }
                await put(job); notify();
                GlossaryLog.info('任务结束', {
                    id: job.id, state: job.state, error: job.error || null,
                    entries: (job.entries || []).length, resultCount: job.resultCount || 0,
                    covered: job.progress && job.progress.covered, totalLines: job.progress && job.progress.totalLines,
                    ms: Date.now() - jobT0,
                });
            } catch (e) {
                job.state = 'failed';
                job.error = String((e && e.message) || e);
                await put(job); notify();
                GlossaryLog.error('任务异常: ' + job.error, { id: job.id, title: job.title });
            } finally {
                runningJobId = null;
                rateTrack.delete(job.id);   // 任务结束就不再显示"预计还需"
            }
        };

        // ---------- 队列循环（串行执行） ----------
        const runLoop = async () => {
            if (loopActive) return;
            loopActive = true;
            stopRequested = false;
            try {
                while (!stopRequested) {
                    const jobs = await list();
                    const next = jobs.find((j) => j.state === 'pending' || j.state === 'running');
                    if (!next) break;
                    await executeJob(next);
                }
            } finally {
                loopActive = false;
                notify();
            }
        };

        const stop = () => { stopRequested = true; notify(); };

        // 重试/继续：保留分块缓存与已有条目，只补没覆盖过的行（不重发已成功的块）。
        // 只把任务转回「待处理」——开跑由工具栏「开始/续跑」控制（重试与启动/暂停解耦；
        // 队列正在跑时，转回的任务会被循环自然轮到）
        const retry = async (id) => {
            const job = await get(id);
            if (!job) return;
            job.state = 'pending';
            job.error = null;
            await put(job);
            notify();
        };

        // 「重试」可用判据（行内「重试」按钮与工具栏「重试未完成」共用同一份逻辑，避免两处漂移）：
        // 不是 running，且有没覆盖到的行；或 pending 但已经跑过（有 progress）。
        // 刚入队、一行都没跑的 pending 不算（那是「开始/续跑」的活）
        const jobLeftLines = (job) => {
            const p = job.progress;
            const totalLinesN = p && Number(p.totalLines) > 0 ? Number(p.totalLines) : 0;
            const coveredN = p ? Number(p.covered) : NaN;
            return (totalLinesN > 0 && Number.isFinite(coveredN))
                ? Math.max(0, totalLinesN - coveredN)
                : (p ? Number(p.pendingLines) || 0 : 0);
        };
        const isJobRetryable = (job) => job.state !== 'running' && (jobLeftLines(job) > 0 || (job.state === 'pending' && !!job.progress));

        // 重跑：整本重新覆盖一遍（成功的分块走缓存不重发，失败过的那些才会重新请求）
        // 与「重试」的区别：不保留已有条目和进度，结果整批重算（「建议删」标记也一并清掉）。
        // 同样只转回「待处理」，开跑由「开始/续跑」控制
        const rerun = async (id) => {
            const job = await get(id);
            if (!job) return;
            job.entries = null;
            job.resultCount = 0;
            job.progress = null;
            job.everFailed = false;
            job.seedLedger = null;   // 重跑 = 全部重来：种子账本一并清空
            job.boost = null;
            job.state = 'pending';
            job.error = null;
            await put(job);
            notify();
        };

        // ---------- 续跑（页面加载时） ----------
        const init = (scriptInstance) => {
            scriptRef = scriptInstance;
            GlossaryDB.requestPersist().catch(() => { });
            setTimeout(async () => {
                try {
                    const jobs = await list();
                    let dirty = false;
                    for (const job of jobs) {
                        if (job.state === 'running') { job.state = 'pending'; await put(job); dirty = true; }
                    }
                    const qs = queueSettings();
                    if (qs['自动续跑'] && jobs.some((j) => j.state === 'pending')) {
                        runLoop();
                    } else if (dirty) {
                        notify();
                    }
                } catch (e) { }
            }, 2500);
        };

        // ---------- 备份导出 / 导入 ----------
        const exportBackup = async () => {
            const jobs = await list();
            return {
                version: 1,
                exportedAt: Date.now(),
                jobs: jobs.map((j) => ({ ...j, state: j.state === 'running' ? 'pending' : j.state })),
            };
        };

        const importBackup = async (data) => {
            if (!data || !Array.isArray(data.jobs)) throw new Error('备份格式不正确');
            const existing = new Set((await list()).map((j) => j.id));
            let added = 0;
            for (const job of data.jobs) {
                if (!job || !job.id || existing.has(job.id)) continue;
                if (!job.target || !job.options) continue;
                if (job.state === 'running') job.state = 'pending';
                await GlossaryDB.put('jobs', job);
                // 曾经的删除墓碑要清掉：否则这个 id 之后的 put() 会被静默忽略（进度/状态再也写不进去）
                deletedIds.delete(job.id);
                added += 1;
            }
            notify();
            return added;
        };

        // ---------- 清理 ----------
        const cleanup = async (keepDone) => {
            const jobs = await list();
            const done = jobs.filter((j) => j.state === 'done');
            // 注意：保留数可以是 0（全部清理），不能用 `|| 5` 兜底
            const parsed = Number(keepDone);
            const keep = Number.isFinite(parsed) ? Math.max(0, parsed) : 5;
            const toRemove = done.slice(0, Math.max(0, done.length - keep));
            for (const job of toRemove) { await GlossaryDB.delete('jobs', job.id); await purgeChunks(job.id); }
            notify();
            return toRemove.length;
        };

        // ---------- 入队来源 ----------
        const addCurrentPage = async () => {
            // 只认当前这个小说页；别的页面让「加入收藏页 / 加入本地书架」来
            // （以前在任何页面点它都会静默弹出"选择本地卷"，和按钮名字对不上）
            if (!/^\/(novel|wenku)\//.test(window.location.pathname)) {
                NotificationUtils.showWarning('「加入当前页」只在小说详情页（/novel/…）或文库页（/wenku/…）生效；批量加请用「加入收藏页 / 加入本地书架」');
                return 0;
            }
            const target = await resolveGlossaryTarget();
            if (!target) return 0;
            const created = await addJobs([target], extractSettingsWithRuntime());
            NotificationUtils.showSuccess(`已加入队列：${GlossaryTargets.describe(target)}`);
            return created.length;
        };

        const addFavoriteWeb = async (limit) => {
            if (!/^\/favorite\/web/.test(window.location.pathname)) {
                NotificationUtils.showWarning('请在收藏页（/favorite/web）使用');
                return 0;
            }
            const url = new URL(window.location.href);
            const id = url.pathname.endsWith('/web') ? 'default' : url.pathname.split('/').pop();
            const targets = [];
            let page = 0;
            while (targets.length < limit) {
                const res = await script.fetch(`${url.origin}/api/user/favored-web/${id}?page=${page}&pageSize=90&sort=update`);
                if (!res.ok) break;
                const data = await res.json();
                const items = data.items || [];
                items.forEach((item) => {
                    if (targets.length >= limit) return;
                    targets.push({
                        kind: 'web',
                        providerId: item.providerId,
                        novelId: item.novelId,
                        title: item.titleZh || item.titleJp || item.novelId,
                    });
                });
                if (items.length < 90) break;
                page += 1;
            }
            if (targets.length === 0) {
                NotificationUtils.showWarning('没有获取到收藏小说');
                return 0;
            }
            await addJobs(targets, extractSettingsWithRuntime());
            NotificationUtils.showSuccess(`已加入 ${targets.length} 本收藏小说`);
            return targets.length;
        };

        const addLocalVolumes = async (onlyEmptyGlossary = true) => {
            const volumes = await GlossaryTargets.listLocalVolumes();
            const picked = onlyEmptyGlossary ? volumes.filter((v) => (v.glossaryCount || 0) === 0) : volumes;
            if (picked.length === 0) {
                NotificationUtils.showWarning('没有符合条件的本地卷');
                return 0;
            }
            if (!confirm(`将 ${picked.length} 本本地卷加入队列？`)) return 0;
            await addJobs(picked.map((v) => ({ kind: 'local', volumeId: v.id, title: v.id })), extractSettingsWithRuntime());
            NotificationUtils.showSuccess(`已加入 ${picked.length} 本本地卷`);
            return picked.length;
        };

        // ---------- 队列面板 ----------
        let queueHintOpen = false;   // 底部「说明」默认收起（这次页面会话内记住展开状态）
        const openPanel = () => {
            // 触发样式注入
            const warm = GlossaryUI.status('术语队列');
            warm.close();
            const old = document.getElementById('ntr-queue-overlay');
            if (old) old.remove();

            const overlay = document.createElement('div');
            overlay.id = 'ntr-queue-overlay';
            overlay.className = 'ntr-g-overlay';
            const card = document.createElement('div');
            card.className = 'ntr-g-card';
            overlay.appendChild(card);

            const head = document.createElement('div');
            head.className = 'ntr-g-head';
            const titleEl = document.createElement('div');
            titleEl.className = 'ntr-g-title';
            titleEl.textContent = '术语队列';
            const statsEl = document.createElement('div');
            statsEl.className = 'ntr-g-stats';
            // 右侧的进度预计（块速度 + 预计还需多久）
            const etaEl = document.createElement('div');
            etaEl.className = 'ntr-g-stats ntr-g-eta';
            etaEl.id = 'ntr-g-eta';
            head.appendChild(titleEl);
            head.appendChild(statsEl);
            head.appendChild(etaEl);
            card.appendChild(head);

            const toolbar = document.createElement('div');
            toolbar.className = 'ntr-g-toolbar';
            const mkBtn = (label, fn) => {
                const b = document.createElement('button');
                b.className = 'ntr-g-btn';
                b.textContent = label;
                b.onclick = () => Promise.resolve(fn()).catch((e) => NotificationUtils.showError(String(e)));
                toolbar.appendChild(b);
                return b;
            };
            mkBtn('加入当前页', () => addCurrentPage());
            mkBtn('加入收藏页', () => addFavoriteWeb(Number(queueSettings()['收藏添加上限']) || 30));
            mkBtn('加入本地书架', () => addLocalVolumes());
            // 这几个按钮的状态在 render() 里跟着队列刷新（跑动中/空闲/空队列各有对应）
            const btnRun = mkBtn('开始/续跑', () => runLoop());
            // 一键重试：把所有"没跑完"（行内会出现「重试」）的任务转回待处理；开跑仍由「开始/续跑」控制
            const btnRetryAll = mkBtn('重试未完成', async () => {
                const jobs = await list();
                const targets = jobs.filter(isJobRetryable);
                if (!targets.length) {
                    NotificationUtils.showWarning('没有需要重试的任务：「待确认/失败」里还有没覆盖到的行、或跑过没跑完的才需要');
                    return;
                }
                for (const j of targets) await retry(j.id);
                NotificationUtils.showSuccess(`已把 ${targets.length} 个没跑完的任务转回待处理；队列没在跑的话，点「开始/续跑」开跑（成功的分块走缓存、不会重发）`);
            });
            const btnStop = mkBtn('停止', () => stop());
            // 队列面板自己的"运行翻译器"下拉：默认值=跟随「AI提取术语表」的翻译器；
            // 选中具体 worker 后，新入队任务 + 队列里 pending 任务的 options.workerId 会被它覆盖
            // （已经开跑或带结果的，按既有快照走，不被覆盖）
            const btnTranslator = mkBtn('运行翻译器 ▾', () => openTranslatorPopover());
            btnTranslator.classList.add('ntr-g-shrink');   // 文案会带 worker id 变长，工具栏里限宽省略（完整值在 title 里）
            const btnExport = mkBtn('汇出备份', async () => {
                const data = await exportBackup();
                GlossaryUI.downloadText(`ntr-glossary-queue.${Date.now()}.json`, JSON.stringify(data, null, 2));
            });
            const importPanelFile = () => {
                const input = document.createElement('input');
                input.type = 'file';
                input.accept = '.json,application/json';
                input.onchange = async () => {
                    const file = input.files && input.files[0];
                    if (!file) return;
                    try {
                        const data = JSON.parse(await file.text());
                        const added = await importBackup(data);
                        NotificationUtils.showSuccess(`已汇入 ${added} 个任务`);
                        render();
                    } catch (e) {
                        NotificationUtils.showError(`汇入失败：${e.message}`);
                    }
                };
                input.click();
            };
            mkBtn('汇入备份', () => importPanelFile());
            const btnCleanup = mkBtn('清理已完成', async () => {
                const n = await cleanup(queueSettings()['保留已完成']);
                NotificationUtils.showSuccess(`已清理 ${n} 个`);
            });
            mkBtn('重新整理', () => render());
            // 调试日志：warn/error 一直在记，开了「调试日志」设置才有 info 级；导出便于排查（贴给我看）
            mkBtn('导出日志', async () => {
                const stats = GlossaryLog.stats();
                if (stats.kept === 0) {
                    NotificationUtils.showWarning('日志是空的：先在「AI提取术语表」的设置里勾上「调试日志」再跑一次');
                    return;
                }
                const head = [
                    `# ntr-toolbox-alpha 日志（${new Date().toLocaleString()}）`,
                    `# 调试日志：${stats.enabled ? '开' : '关（只留了警告/错误；要看全部请勾「调试日志」）'}`,
                    `# 条数：${stats.kept}（其中警告/错误 ${stats.errors}）`,
                    '',
                ].join('\n');
                GlossaryUI.downloadText(`nta-log.${Date.now()}.txt`, head + GlossaryLog.format());
            });
            card.appendChild(toolbar);

            // 「运行翻译器」popover：选择哪个 worker，pending 任务立刻对齐；再次点同一按钮或点外部/Esc 关闭
            let translatorPopover = null;
            const closeTranslatorPopover = () => { if (translatorPopover) { translatorPopover.remove(); translatorPopover = null; btnTranslator.textContent = '运行翻译器 ▾'; } };
            const openTranslatorPopover = () => {
                if (translatorPopover) { closeTranslatorPopover(); return; }
                const cur = readQueueRuntime().workerId;
                const pop = document.createElement('div');
                pop.className = 'ntr-g-popover';
                pop.style.position = 'absolute';
                pop.style.zIndex = '999999';
                pop.style.minWidth = '240px';
                pop.style.padding = '8px';
                pop.style.background = '#1e1e22';
                pop.style.border = '1px solid #444';
                pop.style.borderRadius = '6px';
                pop.style.boxShadow = '0 4px 14px rgba(0,0,0,0.4)';
                const label = document.createElement('div');
                label.textContent = '队列「运行翻译器」（只影响新入队 + 未跑的任务）';
                label.style.fontSize = '12px';
                label.style.color = '#aaa';
                label.style.marginBottom = '6px';
                pop.appendChild(label);
                const select = document.createElement('select');
                select.style.width = '100%';
                select.style.padding = '4px';
                select.style.background = '#2a2a30';
                select.style.color = '#eee';
                select.style.border = '1px solid #444';
                select.style.borderRadius = '4px';
                // 第一项 = 跟随 AI 提取术语表
                const optFollow = document.createElement('option');
                optFollow.value = '';
                const liveWorker = extractSettings().workerId || '';
                optFollow.textContent = `跟随 [「AI提取术语表」当前：${liveWorker || '全部（自动轮换）'}]`;
                select.appendChild(optFollow);
                workspaceTranslatorOptions().forEach((o) => {
                    if (o.value === '') return;  // 第一项已加
                    const opt = document.createElement('option');
                    opt.value = o.value;
                    opt.textContent = o.label;
                    select.appendChild(opt);
                });
                select.value = cur;
                select.onchange = async () => {
                    await writeQueueRuntime({ workerId: select.value });
                    closeTranslatorPopover();
                    NotificationUtils.showSuccess(select.value ? `运行翻译器已切到「${select.value}」` : '运行翻译器已恢复为跟随');
                };
                pop.appendChild(select);
                const hint = document.createElement('div');
                hint.style.fontSize = '11px';
                hint.style.color = '#888';
                hint.style.marginTop = '6px';
                hint.textContent = '已覆盖完成（done / 100%）的任务不动，其它立即对齐';
                pop.appendChild(hint);
                // 定位在按钮下方
                const rect = btnTranslator.getBoundingClientRect();
                pop.style.top = (window.scrollY + rect.bottom + 4) + 'px';
                pop.style.left = (window.scrollX + rect.left) + 'px';
                document.body.appendChild(pop);
                translatorPopover = pop;
                btnTranslator.textContent = '运行翻译器 ▴';
                setTimeout(() => {
                    const onOutside = (ev) => { if (!pop.contains(ev.target) && ev.target !== btnTranslator) { closeTranslatorPopover(); document.removeEventListener('click', onOutside); } };
                    document.addEventListener('click', onOutside);
                }, 0);
            };

            const body = document.createElement('div');
            body.className = 'ntr-g-body';
            const table = document.createElement('table');
            table.innerHTML = '<thead><tr><th style="width:24%">目标</th><th style="width:70px">状态</th><th style="width:22%">进度</th><th style="width:60px">结果</th><th>备注</th><th style="width:200px">操作</th></tr></thead>';
            const tbody = document.createElement('tbody');
            table.appendChild(tbody);
            body.appendChild(table);
            card.appendChild(body);

            const foot = document.createElement('div');
            foot.className = 'ntr-g-foot';
            const hint = document.createElement('div');
            hint.className = 'ntr-g-warn';
            hint.textContent = '并发/RPM/逾时：右键「术语队列」的设置里可覆盖（0=跟随「AI提取术语表」），执行时实时生效（下一次开跑/续跑；正在跑的不变）；分块字数·最大轮数·行数上限·翻译器 在入队时固定。队列串行执行；「待确认」的任务点“预览”走 预览-合并-diff 后再写入。刷新/重开页面会自动续跑。「重试」= 把任务转回「待处理」、只补没覆盖到的正文行；「重跑」= 转回「待处理」后整本重来一遍（成功的分块走缓存；只有曾经失败的块才会重新请求，全都在缓存里时它会提示而不是空跑）；「重试未完成」= 把所有没跑完的一次性转回「待处理」。重试/重跑只改任务状态，开跑统一由「开始/续跑」控制（队列正在跑时，转回的任务会被自动轮到）。队列面板的「运行翻译器 ▾」选定后，未跑完的任务（pending / running / 还有未覆盖行的 review·failed）立即对齐；已写入完成（done）的不动。';
            hint.style.display = queueHintOpen ? '' : 'none';
            const btnHint = document.createElement('button');
            btnHint.className = 'ntr-g-btn';
            btnHint.textContent = queueHintOpen ? '说明 ▾' : '说明 ▸';
            btnHint.title = '展开/收起面板操作说明（并发覆盖、重试/重跑语义等）';
            btnHint.onclick = () => {
                queueHintOpen = !queueHintOpen;
                hint.style.display = queueHintOpen ? '' : 'none';
                btnHint.textContent = queueHintOpen ? '说明 ▾' : '说明 ▸';
            };
            const btnClose = document.createElement('button');
            btnClose.className = 'ntr-g-btn';
            btnClose.textContent = '关闭';
            btnClose.onclick = () => { overlay.remove(); panelRefresh = null; };
            foot.appendChild(hint);
            foot.appendChild(btnHint);
            foot.appendChild(btnClose);
            card.appendChild(foot);

            const stateLabels = {
                pending: '待处理', running: '提取中', review: '待确认', done: '完成', failed: '失败', stopped: '已停止',
            };

            const render = async () => {
                if (!document.body.contains(overlay)) { panelRefresh = null; return; }
                const jobs = await list();
                // 工具栏按钮跟着状态亮/灭：点不动比"点了没反应"清楚
                const anyPending = jobs.some((j) => j.state === 'pending');
                btnRun.disabled = loopActive || !anyPending;
                btnRun.title = loopActive ? '队列正在跑（串行执行）'
                    : (anyPending ? '把「待处理」的任务依次跑完（队列串行执行）' : '没有待处理的任务：先用左边的「加入」按钮排任务');
                btnStop.disabled = !loopActive && !runningJobId;
                btnStop.title = btnStop.disabled ? '当前没有任务在跑'
                    : '停在当前分块之后；已跑过的分块都在缓存里，可以再「开始/续跑」接着来';
                btnExport.disabled = jobs.length === 0;
                btnExport.title = jobs.length === 0 ? '队列是空的，没有可导出的任务'
                    : '导出全部任务（不含分块缓存；换浏览器导入后会从断点续跑）';
                btnCleanup.disabled = !jobs.some((j) => j.state === 'done');
                btnCleanup.title = btnCleanup.disabled ? '没有「完成」状态的任务可清理'
                    : '按队列设置里的「保留已完成」清理掉多余的完成任务';
                const retryableN = jobs.filter(isJobRetryable).length;
                btnRetryAll.disabled = retryableN === 0;
                btnRetryAll.title = retryableN === 0
                    ? '没有需要重试的任务：要「待确认/失败」里还有没覆盖到的行、或跑过没跑完的'
                    : `把 ${retryableN} 个没跑完的任务转回待处理（队列没在跑时点「开始/续跑」开跑；成功的分块走缓存、不会重发）`;
                // 「运行翻译器」按钮：选了具体 worker 时显示出来
                const ovr = readQueueRuntime().workerId;
                btnTranslator.textContent = ovr ? `运行翻译器：${ovr} ▾` : '运行翻译器 ▾';
                btnTranslator.title = ovr
                    ? `当前覆盖：${ovr}（未跑完的任务立即对齐；写入完成（done）的不动）`
                    : '当前跟随「AI提取术语表」的翻译器选择（点开后可临时换成某个 worker）';
                statsEl.textContent = `共 ${jobs.length} | 待处理 ${jobs.filter((j) => j.state === 'pending').length} | 提取中 ${jobs.filter((j) => j.state === 'running').length} | 待确认 ${jobs.filter((j) => j.state === 'review').length} | 完成 ${jobs.filter((j) => j.state === 'done').length} | 失败 ${jobs.filter((j) => j.state === 'failed').length}`;
                // 进度预计：只对正在跑的那个任务算（队列是串行的）
                const runningJob = jobs.find((j) => j.state === 'running');
                if (runningJob) {
                    const p = runningJob.progress || {};
                    const info = etaFor(p, (rateTrack.get(runningJob.id) || {}).samples);
                    const bits = [];
                    const roundTxt = `第 ${Math.min((Number(p.round) || 0) + 1, Number(p.maxRounds) || 1)} 轮 `;
                    bits.push(`${roundTxt}${info ? info.done : (Number(p.chunksDone) || 0) - (Number(p.chunksBase) || 0)}/${p.totalChunks || '?'} 块`);
                    if (info && info.perMin > 0) {
                        bits.push(`${info.perMin.toFixed(1)} 块/分`);
                        bits.push(`预计还需 ${fmtEta(info.etaMs)}`);
                    } else if (info) {
                        bits.push('速度计算中…');
                    }
                    const waiting = jobs.filter((j) => j.state === 'pending').length;
                    if (waiting > 0) bits.push(`（还有 ${waiting} 个排队）`);
                    const rt = jobRuntime(runningJob.options);
                    bits.push(`并发 ${rt.concurrency}${rt.rpm > 0 ? ` · RPM ${rt.rpm}` : ''} · 逾时 ${Math.round(rt.timeoutMs / 1000)}s`);
                    etaEl.textContent = bits.join(' · ');
                } else {
                    etaEl.textContent = '';
                }
                tbody.innerHTML = '';
                jobs.forEach((job) => {
                    const tr = document.createElement('tr');
                    // 正在「再次筛选」的行：徽章显示「待筛选」（颜色跟「待确认」同族），而不是原状态
                    const auditing = auditingIds.has(job.id);
                    const tdTitle = document.createElement('td');
                    tdTitle.textContent = job.title || GlossaryTargets.describe(job.target);
                    tdTitle.title = GlossaryTargets.describe(job.target);
                    const tdState = document.createElement('td');
                    const badge = document.createElement('span');
                    badge.className = 'ntr-g-badge ' + (auditing ? 'conflict' : (job.state === 'done' ? 'add' : (job.state === 'review' ? 'conflict' : (job.state === 'failed' ? 'partial' : 'same'))));
                    badge.textContent = auditing ? '待筛选' : (stateLabels[job.state] || job.state);
                    tdState.appendChild(badge);
                    const tdProg = document.createElement('td');
                    if (job.progress) {
                        const p = job.progress;
                        if (p.sync) {
                            tdProg.textContent = p.sync;
                        } else {
                            // chunksDone/chunksFailed 是跨轮累计的"块次"（失败块在后面几轮重试成功后还会再计一次），
                            // 所以进度看"本轮块数 + 行覆盖率"，累计失败单独标注，别让它看起来像"漏了多少块"
                            const roundDone = Math.max(0, (Number(p.chunksDone) || 0) - (Number(p.chunksBase) || 0));
                            const totalLines = Number(p.totalLines) || 0;
                            const coveredN = Number(p.covered);
                            const hasCoverage = totalLines > 0 && Number.isFinite(coveredN);
                            const leftLines = hasCoverage ? Math.max(0, totalLines - coveredN) : (Number(p.pendingLines) || 0);
                            const bits = [
                                `已跑 ${Number(p.round) || 0}/${p.maxRounds} 轮`,
                                `本轮 ${roundDone}/${p.totalChunks || '?'} 块`,
                            ];
                            bits.push(hasCoverage
                                ? (leftLines > 0 ? `已覆盖 ${coveredN}/${totalLines} 行 · 待 ${leftLines}` : `已覆盖 ${totalLines}/${totalLines} 行`)
                                : `待 ${p.pendingLines} 行`);
                            if (Number(p.chunksFailed) > 0) bits.push(`曾有 ${p.chunksFailed} 块次失败`);
                            tdProg.textContent = bits.join(' · ');
                        }
                    } else {
                        tdProg.textContent = '—';
                    }
                    const tdResult = document.createElement('td');
                    tdResult.textContent = job.resultCount || 0;
                    const tdNote = document.createElement('td');
                    tdNote.textContent = job.error || '';
                    tdNote.style.color = job.error ? '#E8A96A' : '#888';
                    const tdOps = document.createElement('td');
                    const mkOp = (label, fn, title) => {
                        const b = document.createElement('button');
                        b.className = 'ntr-g-btn';
                        b.textContent = label;
                        if (title) b.title = title;
                        b.style.padding = '2px 8px';
                        b.style.marginRight = '4px';
                        b.onclick = () => Promise.resolve(fn()).catch((e) => NotificationUtils.showError(String(e)));
                        tdOps.appendChild(b);
                        return b;
                    };
                    // 「预览」和「筛选」的条件保持一致：完成（写入过）的任务同样能打开看/再筛
                    if ((job.state === 'review' || job.state === 'done') && job.entries && job.entries.length > 0) {
                        mkOp('预览', () => openReview(job));
                    }
                    if ((job.state === 'review' || job.state === 'done') && job.entries && job.entries.length > 0) {
                        const bFilter = mkOp('筛选', async () => {
                            const n = job.entries.length;
                            const conc = Math.max(1, Number(jobRuntime(job.options).concurrency) || 1);
                            const par = conc > 1 ? `，按「并发 ${conc}」分批并行` : '';
                            if (!confirm(`把这条任务的 ${n} 条术语发给模型筛一遍${par}？\n\n只会打「建议删」标签（可在「预览」里查看/撤销），不会删除或写入任何数据。`)) return;
                            // 条数多时要跑好几分钟：给个进度浮窗（关掉浮窗不影响后台继续跑）
                            const progress = GlossaryUI.status(`再次筛选 - ${job.title || ''}`, {});
                            try {
                                const res = await auditJob(job.id, {
                                    onProgress: (p) => {
                                        const d = Number.isFinite(p.done) ? p.done : 0;
                                        progress.update(`筛选中：已完成 ${d}/${p.batches} 批（每批最多 300 条）`, p.batches ? d / p.batches : 0);
                                    },
                                });
                                const msg = res.marks.size > 0
                                    ? `筛选完成：${res.marks.size} 条建议删${res.unmatched ? `，${res.unmatched} 条未匹配` : ''}${res.failed ? `；部分批次失败：${res.failed}` : ''}`
                                    : (res.failed ? `筛选失败：${res.failed}` : '筛选完成：没有发现多余条目');
                                if (res.marks.size > 0 || !res.failed) NotificationUtils.showSuccess(msg);
                                else NotificationUtils.showWarning(msg);
                            } finally { progress.close(); }
                        });
                        if (auditing) {
                            // 正在筛：按钮置灰，防止重复开跑（进度看浮窗；徽章已显示「待筛选」）
                            bFilter.disabled = true;
                            bFilter.style.opacity = '0.65';
                            bFilter.title = '正在筛选…（关掉进度浮窗不影响后台继续跑）';
                        }
                    }
                    // 「重试」= 转「待处理」，只补没覆盖到的正文行（已有条目/分块缓存都保留）
                    // 「重跑」= 转「待处理」后整本重来一次（成功的分块走缓存，只有失败过的块重新请求；结果整批重算）
                    const totalLinesN = job.progress && Number(job.progress.totalLines) > 0 ? Number(job.progress.totalLines) : 0;
                    const coveredN = job.progress ? Number(job.progress.covered) : NaN;
                    const leftLines = jobLeftLines(job);
                    const running = job.state === 'running';
                    const partial = leftLines > 0;
                    // 可用判据与工具栏「重试未完成」共用（见 isJobRetryable）：跑过的、或还有没覆盖到的行。
                    // 点击只把任务转回「待处理」；开跑由工具栏「开始/续跑」控制
                    if (isJobRetryable(job)) {
                        mkOp('重试', () => retry(job.id), leftLines > 0
                            ? `重试：只补没覆盖到的 ${leftLines} 行（任务转「待处理」，点「开始/续跑」开跑）；已成功的分块走缓存、不会重发`
                            : '重试：任务转「待处理」（点「开始/续跑」开跑）；已成功的分块走缓存、不会重发');
                    }
                    // 曾有失败（job.everFailed 是跨"重试/补跑"保留的历史标记：整本缓存可能不全
                    // → 重跑仍有活干）。老任务没这个字段时退回看累计失败块次
                    const anyFail = job.everFailed === true || Number(job.progress && job.progress.chunksFailed) > 0;
                    // 置灰（"全都在缓存里"）只在缓存确实齐全时给：有完整的覆盖率数据 + 全部覆盖 + 零失败。
                    // 否则像"取文/网络早期失败（Failed to fetch，还没有任何覆盖率数据）"这种，
                    // 重跑是真有活干的，不能拿"不会发请求"的提示把它挡掉
                    const cacheComplete = !!job.progress && totalLinesN > 0 && Number.isFinite(coveredN) && coveredN >= totalLinesN && !anyFail;
                    if (!running && job.state !== 'pending'
                        && (job.state === 'failed' || job.state === 'review' || job.state === 'done')
                        && (!partial || job.state === 'failed')) {   // 失败的任务不该被"还有未覆盖行"挡住「重跑」
                        // 置灰只给"结果已经正常"的任务（review/done）。失败的任务哪怕缓存齐全也得能真正重跑：
                        // 失败原因可能正是"缓存回放后的结果"（比如零词条），重跑会先清掉它的分块缓存、全部重新请求
                        if (cacheComplete && job.state !== 'failed') {
                            // 全书都覆盖了、也没有失败过的块 → 重跑只会把缓存原样回放（不发请求、结果不变）
                            const b = mkOp('重跑', () => {
                                NotificationUtils.showWarning('全部分块都还在缓存里：重跑不会发任何请求、结果不会变（只会清掉「建议删」标记）。要强制重新请求，请先「删除」任务再重新入队。');
                            }, '所有分块都已缓存：现在点重跑不会发任何请求（要强制重发请删掉任务重新入队）');
                            b.style.opacity = '0.65';
                        } else {
                            mkOp('重跑', async () => {
                                const n = (job.entries || []).length;
                                const cf = Number(job.progress && job.progress.chunksFailed) || 0;
                                const failNote = cf > 0 ? `\n曾有 ${cf} 块次失败，它们会重新请求。` : '';
                                const forceNote = cacheComplete
                                    ? '\n分块缓存虽然齐全，但结果是失败的——会先清掉它的分块缓存，全部重新请求（消耗 token，可能几分钟）。'
                                    : '';
                                const entryNote = n > 0
                                    ? `\n已有 ${n} 条结果会整批重算（弹层里的「建议删」标记会清掉），写入前仍会在预览弹层里确认。`
                                    : '\n这次会重新取文、从头提取；写入前仍会在预览弹层里确认。';
                                if (!confirm(`重跑《${job.title}》？\n\n成功的分块走缓存、不会重发；只有失败过的块会重新请求（消耗 token，可能几分钟）。${failNote}${forceNote}${entryNote}\n确认后任务转回「待处理」：队列没在跑就点「开始/续跑」开跑。`)) return;
                                if (cacheComplete) await purgeChunks(job.id);   // 缓存齐全但失败过 → 清掉缓存，强制全新请求
                                await rerun(job.id);
                            }, '整本重新覆盖一遍：成功的分块走缓存不重发，只有失败过的块会重新请求；结果整批重算');
                        }
                    }
                    mkOp('删除', async () => {
                        if (!confirm(`删除任务《${job.title}》？`)) return;
                        await remove(job.id);
                    });
                    tr.appendChild(tdTitle);
                    tr.appendChild(tdState);
                    tr.appendChild(tdProg);
                    tr.appendChild(tdResult);
                    tr.appendChild(tdNote);
                    tr.appendChild(tdOps);
                    tbody.appendChild(tr);
                });
                if (jobs.length === 0) {
                    const tr = document.createElement('tr');
                    const td = document.createElement('td');
                    td.colSpan = 6;
                    td.textContent = '队列为空：用上面的按钮加入小说/本地卷';
                    td.style.color = '#888';
                    tr.appendChild(td);
                    tbody.appendChild(tr);
                }
            };

            document.body.appendChild(overlay);
            panelRefresh = () => { render(); };
            render();
            // 面板打开时轮询刷新
            const timer = setInterval(() => {
                if (!document.body.contains(overlay)) { clearInterval(timer); return; }
                render();
            }, 1500);
        };

        // 打开某个任务的 预览-合并-diff（写入后标记完成）
        const openReview = async (job) => {
            const existing = await GlossaryTargets.loadGlossary(job.target);
            GlossaryUI.open({
                title: `队列预览 - ${job.title}（${(job.entries || []).length} 条）`,
                target: job.target,
                entries: job.entries || [],
                existing,
                mode: 'merge',
                onWrite: async (picked) => {
                    const result = await writeGlossaryMerged(job.target, picked);
                    job.state = 'done';
                    job.error = null;
                    await put(job);
                    notify();
                    return result;
                },
                onAudit: (entries, { onProgress }) => auditJob(job.id, { onProgress }),
                auditConcurrency: jobRuntime(job.options).concurrency,   // 和「筛选」按钮一样实时读「并发」
            });
        };

        return {
            init, list, get, put, remove, addJobs, retry, rerun, stop, runLoop, cleanup, counts,
            exportBackup, importBackup, openPanel, openReview, executeJob, auditJob,
            extractSettings, extractSettingsWithRuntime, jobRuntime, queueSettings, readQueueRuntime, writeQueueRuntime,
            setGlanceHook: (fn) => { glanceHook = fn; },
            etaFor, _rateSamples: (id) => (rateTrack.get(id) || {}).samples || [],
            _state: () => ({ loopActive, stopRequested, runningJobId, auditingIds: [...auditingIds] }),
        };
    })();

    // -----------------------------------
    // Storage Utils
    // -----------------------------------
    // 站点工作区数据（workspace-sakura / workspace-gpt）的读写层（clean-room 重写，契约：docs/cleanroom/spec-02-helper-layer.md §5）
    // 注意：这是「上游工作区」的 localStorage，不是分叉术语队列的 IndexedDB 库（ntr-glossary）
    class StorageUtils {
        // n.novelia.cc 与老镜像域的工作区键名不同；gpt 两域同名
        static sakura = location.hostname === 'n.novelia.cc' ? 'workspace-sakura' : 'sakura-workspace';
        static gpt = 'workspace-gpt';

        // 面板停在工作区页时由主循环调用：读出再写回，顺带把缺的数组字段补齐
        static async update() {
            const key = window.location.pathname.includes('workspace/sakura') ? this.sakura
                : (window.location.pathname.includes('workspace/gpt') ? this.gpt : null);
            if (!key) return;
            await this._setData(key, await this._getData(key));
        }

        static async _setData(key, data) {
            const serialized = JSON.stringify(data);
            localStorage.setItem(key, serialized);
            // 合成 storage 事件：让同页监听者（以及站点脚本）感知工作区数据变化
            window.dispatchEvent(new StorageEvent('storage', {
                key: key,
                newValue: serialized,
                url: window.location.href,
                storageArea: localStorage
            }));
        }

        static async _getData(key) {
            let raw = null;
            try {
                raw = localStorage.getItem(key);
            } catch (e) { }
            if (raw) {
                try {
                    const data = JSON.parse(raw);
                    // 缺哪个数组补哪个：站点侧旧数据/半成品数据也能安全读写（其余字段原样保留）
                    data.workers = data.workers || [];
                    data.jobs = data.jobs || [];
                    data.uncompletedJobs = data.uncompletedJobs || [];
                    return data;
                } catch (e) {
                    // 坏数据当场清掉，下次进来是干净结构
                    console.error('Failed to parse localStorage data for key:', key, e);
                    try {
                        localStorage.removeItem(key);
                    } catch (removeError) {
                        console.error('Failed to remove corrupted data:', removeError);
                    }
                }
            }
            return { workers: [], jobs: [], uncompletedJobs: [] };
        }

        // 同 id 覆盖、新 id 追加
        static _upsertWorker(data, worker) {
            const existingIndex = data.workers.findIndex((w) => w.id === worker.id);
            if (existingIndex !== -1) {
                data.workers[existingIndex] = worker;
            } else {
                data.workers.push(worker);
            }
        }

        static async addSakuraWorker(id, endpoint, amount = null, prevSegLength = 500, segLength = 500) {
            const data = await this._getData(this.sakura);
            const total = amount ?? -1;
            const ids = (total === -1) ? [id] : Array.from({ length: total }, (_, i) => `${id}${i + 1}`);
            ids.forEach((workerId) => this._upsertWorker(data, { id: workerId, endpoint, prevSegLength, segLength }));
            await this._setData(this.sakura, data);
        }

        static async addGPTWorker(id, model, endpoint, key, amount = null) {
            const data = await this._getData(this.gpt);
            const total = amount ?? -1;
            const ids = (total === -1) ? [id] : Array.from({ length: total }, (_, i) => `${id}${i + 1}`);
            ids.forEach((workerId) => this._upsertWorker(data, { id: workerId, type: 'api', model, endpoint, key }));
            await this._setData(this.gpt, data);
        }

        static async removeWorker(key, id) {
            const data = await this._getData(key);
            data.workers = data.workers.filter((w) => w.id !== id);
            await this._setData(key, data);
        }

        // 语义与名字相反：留下的是「排除名单」里的（共享/本机这类不归脚本管的），其余全删
        static async removeAllWorkers(key, exclude = []) {
            const data = await this._getData(key);
            data.workers = data.workers.filter((w) => exclude.includes(w.id));
            await this._setData(key, data);
        }

        static async addJob(key, task, description, createAt = Date.now()) {
            const data = await this._getData(key);
            data.jobs.push({ task, description, createAt });
            await this._setData(key, data);
        }

        // 同 task 视为已排队，跳过（createAt 统一取本批调用时刻）
        static async addJobs(key, jobs = [], createAt = Date.now()) {
            const data = await this._getData(key);
            const queued = new Set(data.jobs.map((job) => job.task));
            jobs.forEach(({ task, description }) => {
                if (queued.has(task)) return;
                queued.add(task);
                data.jobs.push({ task, description, createAt });
            });
            await this._setData(key, data);
        }

        static async getUncompletedJobs(key) {
            return (await this._getData(key)).uncompletedJobs;
        }
    }

    // 轻量 toast（clean-room 重写，契约见 docs/cleanroom/spec-01-config-notifications.md §2）：
    // 单容器懒挂载；图标 + 纯文本；1s 后淡出、再 300ms 移除；各条独立计时，不排队不去重。
    // DOM 结构与类名是 e2e 抓取契约，保持不变。
    class NotificationUtils {
        static _ensureTray() {
            if (this._tray) return;
            this._tray = document.createElement('div');
            this._tray.className = 'ntr-notification-container';
            document.body.appendChild(this._tray);
        }

        static showSuccess(text) { this._toast(text, '✅'); }
        static showWarning(text) { this._toast(text, '⚠️'); }
        static showError(text) { this._toast(text, '❌'); }

        static _toast(message, icon) {
            this._ensureTray();
            const item = document.createElement('div');
            item.className = 'ntr-notification-message';
            const iconEl = document.createElement('span');
            iconEl.className = 'ntr-icon';
            iconEl.textContent = icon;
            item.appendChild(iconEl);
            item.appendChild(document.createTextNode(message));
            this._tray.appendChild(item);
            setTimeout(() => {
                item.classList.add('fade-out');
                setTimeout(() => item.remove(), 300);
            }, 1000);
        }
    }


    // -----------------------------------
    // Main Toolbox
    // -----------------------------------
    class NTRToolBox {
        constructor() {
            this.configuration = this.loadConfiguration();
            // 面板运行态：激活的 keep 模块 / 模块行 header 缓存 / 速览角标（分叉）与轮询计时
            this.keepActiveSet = new Set();
            this.headerMap = new Map();
            this.glanceMap = new Map();       // 模块名 → 行尾速览角标元素
            this._lastGlanceRun = 0;
            this._glanceBusy = false;
            this._pollTimer = null;
            this.token = this.initToken();

            this._lastKeepRun = 0;
            this._lastVisRun = 0;
            this._lastEndPoint = window.location.href;

            this.buildGUI();
            this.attachGlobalKeyBindings();
            this.loadKeepStateAndStart();
            this.scheduleNextPoll();

            // 站点自检：启动后跑一遍（看各「站点挂点」有没有变动）
            SiteCheck.bind(this);
            SiteCheck.schedule();
        }

        // 配置合并的底稿：settings 逐项拷贝保证各实例互不影响；_lastRun 归零让 keep 模块马上获得一次执行机会。
        // settings 之外的字段（run/progress 等）故意共享引用——函数不该来自存储，progress 本来就是全局态
        static cloneDefaultModules() {
            return defaultModules.map((mod) => ({
                ...mod,
                settings: mod.settings ? mod.settings.map((s) => ({ ...s })) : [],
                _lastRun: 0,
            }));
        }

        // 标题栏拖拽（鼠标 + 触摸）：拖动中实时夹紧，松手后按视口夹紧并持久化到 ntr-panel-position
        static DragHandler = class {
            constructor(panel, title) {
                this.panel = panel;
                this.title = title;
                this.dragging = false;
                this.offsetX = 0;
                this.offsetY = 0;
                this._bindEvents();
            }

            _bindEvents() {
                const grabPoint = (x, y) => {
                    this.panel.style.transition = 'none';
                    this.dragging = true;
                    this.offsetX = x - this.panel.offsetLeft;
                    this.offsetY = y - this.panel.offsetTop;
                };
                const moveTo = (x, y) => {
                    this.panel.style.left = (x - this.offsetX) + 'px';
                    this.panel.style.top = (y - this.offsetY) + 'px';
                    this.clampPosition();
                };
                const settle = () => {
                    this.dragging = false;
                    this.panel.style.transition = 'width 0.3s ease, height 0.3s ease, top 0.3s ease, left 0.3s ease';
                    const rect = this.panel.getBoundingClientRect();
                    const left = Math.min(Math.max(rect.left, 0), window.innerWidth - rect.width);
                    const top = Math.min(Math.max(rect.top, 0), window.innerHeight - rect.height);
                    this.panel.style.left = left + 'px';
                    this.panel.style.top = top + 'px';
                    localStorage.setItem('ntr-panel-position', JSON.stringify({
                        left: this.panel.style.left,
                        top: this.panel.style.top
                    }));
                };

                this.title.addEventListener('mousedown', (e) => {
                    if (e.button !== 0) return;
                    grabPoint(e.clientX, e.clientY);
                    e.preventDefault();
                });
                document.addEventListener('mousemove', (e) => {
                    if (!this.dragging) return;
                    moveTo(e.clientX, e.clientY);
                });
                document.addEventListener('mouseup', () => {
                    if (!this.dragging) return;
                    settle();
                });

                this.title.addEventListener('touchstart', (e) => {
                    grabPoint(e.touches[0].clientX, e.touches[0].clientY);
                    e.preventDefault();
                }, { passive: false });
                document.addEventListener('touchmove', (e) => {
                    if (!this.dragging) return;
                    moveTo(e.touches[0].clientX, e.touches[0].clientY);
                    e.preventDefault();
                }, { passive: false });
                document.addEventListener('touchend', () => {
                    if (!this.dragging) return;
                    settle();
                }, { passive: false });
            }

            clampPosition() {
                const rect = this.panel.getBoundingClientRect();
                const maxLeft = window.innerWidth - rect.width;
                const maxTop = window.innerHeight - rect.height;
                const left = Math.min(Math.max(parseFloat(this.panel.style.left) || 0, 0), maxLeft);
                const top = Math.min(Math.max(parseFloat(this.panel.style.top) || 0, 0), maxTop);
                this.panel.style.left = left + 'px';
                this.panel.style.top = top + 'px';
            }
        }

        // 会话 token（clean-room 重写，契约见 docs/cleanroom/spec-01-config-notifications.md §3）：
        // auth-v2 是站点当前会话（{token, adminMode}，短效 token + refresh cookie 续期）；
        // auth 是历史格式（{profile:{token}}），停更已久，只在 auth-v2 缺失时回落
        initToken() {
            const extract = (raw, pick) => {
                try {
                    const parsed = JSON.parse(raw);
                    return parsed ? pick(parsed) : null;
                } catch (e) { return null; }
            };
            const v2 = localStorage.getItem('auth-v2');
            if (v2) {
                const token = extract(v2, (d) => d.token || null);
                if (token) return token;
            }
            const legacy = localStorage.getItem('auth');
            if (legacy) {
                const token = extract(legacy, (d) => (d.profile && d.profile.token) || null);
                if (token) return token;
            }
            return null;
        }

        // ---------- 配置存取（clean-room 重写，行为规格：docs/cleanroom/spec-01-config-notifications.md §1） ----------

        _readStoredConfig() {
            let raw = null;
            try { raw = localStorage.getItem(CONFIG_STORAGE_KEY); } catch (e) { return null; }
            if (!raw) return null;
            try {
                const parsed = JSON.parse(raw);
                return (parsed && typeof parsed === 'object') ? parsed : null;
            } catch (e) { return null; }
        }

        _freshConfiguration() {
            return { version: CONFIG_VERSION, modules: NTRToolBox.cloneDefaultModules() };
        }

        // 把存储里的一份模块定义合并进默认定义：字段级门槛见 spec §1.2
        _mergeSavedModule(target, saved) {
            for (const key of Object.keys(saved)) {
                if (key === 'settings' || key === 'whitelist' || key === 'needsTarget' || key === 'settingGroups') continue;
                if (Object.prototype.hasOwnProperty.call(target, key)
                    && typeof target[key] === typeof saved[key]
                    && saved[key] !== undefined) {
                    target[key] = saved[key];
                }
            }
            if (!Array.isArray(saved.settings) || !Array.isArray(target.settings)) return;
            const savedByName = new Map();
            for (const item of saved.settings) {
                if (item && item.name !== undefined) savedByName.set(item.name, item);
            }
            // settings 只认「值」：type/options 由代码定义，默认新增的设置项自动补上
            for (const defSetting of target.settings) {
                const savedSetting = savedByName.get(defSetting.name);
                if (savedSetting && 'value' in savedSetting) defSetting.value = savedSetting.value;
            }
            // 老配置迁移：当年「临时端点」填了即生效，后来才加的「使用临时端点」开关 ——
            // 存档里没有该开关且端点非空 → 视作原本就在用临时端点，替用户把开关勾上
            const endpoint = target.settings.find(s => s.name === '临时端点');
            const switchSetting = target.settings.find(s => s.name === '使用临时端点');
            const savedHadSwitch = saved.settings.some(s => s && s.name === '使用临时端点');
            if (!savedHadSwitch && switchSetting && endpoint && String(endpoint.value || '').trim() !== '') {
                switchSetting.value = true;
            }
        }

        loadConfiguration() {
            const stored = this._readStoredConfig();
            if (!stored || stored.version !== CONFIG_VERSION || !Array.isArray(stored.modules)) {
                return this._freshConfiguration();
            }
            // 以默认深拷贝为底合并：名字对不上号的存储模块直接忽略；
            // whitelist/needsTarget/settingGroups 属代码结构，一律以代码为准（spec §1.2）
            // 模块改名迁移：「同步 Daemon」→「Daemon 连接」（Daemon 地址等设置值原样保留）
            for (const savedMod of stored.modules) {
                if (savedMod && savedMod.name === '同步 Daemon') savedMod.name = 'Daemon 连接';
            }
            const modules = NTRToolBox.cloneDefaultModules();
            const byName = new Map(modules.map(m => [m.name, m]));
            for (const savedMod of stored.modules) {
                const target = savedMod && byName.get(savedMod.name);
                if (target) this._mergeSavedModule(target, savedMod);
            }
            // 函数不来自存储（JSON 序列化丢函数）：run 必须是当前代码里的这一份
            for (const mod of modules) {
                if (typeof mod.run !== 'function') {
                    const def = defaultModules.find(d => d.name === mod.name);
                    if (def && typeof def.run === 'function') mod.run = def.run;
                }
            }
            return { version: CONFIG_VERSION, modules };
        }

        saveConfiguration() {
            localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(this.configuration));
        }

        buildGUI() {
            this.panel = document.createElement('div');
            this.panel.id = 'ntr-panel';

            // 上次关闭时的位置：left/top 都有值才恢复，坏数据当作没存过
            const savedPos = localStorage.getItem('ntr-panel-position');
            if (savedPos) {
                try {
                    const parsed = JSON.parse(savedPos);
                    if (parsed.left && parsed.top) {
                        this.panel.style.left = parsed.left;
                        this.panel.style.top = parsed.top;
                    }
                } catch (e) { }
            }

            this.isMinimized = false;
            this.titleBar = document.createElement('div');
            this.titleBar.className = 'ntr-titlebar';
            this.titleBar.innerHTML = 'NTR Toolbox Alpha ' + VERSION;

            this.toggleSpan = document.createElement('span');
            this.toggleSpan.style.float = 'right';
            this.toggleSpan.textContent = '[-]';
            this.titleBar.appendChild(this.toggleSpan);
            this.panel.appendChild(this.titleBar);

            this.panelBody = document.createElement('div');
            this.panelBody.className = 'ntr-panel-body';
            this.panel.appendChild(this.panelBody);

            this.infoBar = document.createElement('div');
            this.infoBar.className = 'ntr-info';
            const leftInfo = document.createElement('span');
            const rightInfo = document.createElement('span');
            leftInfo.textContent = IS_MOBILE
                ? '单击执行 | ⚙️设置'
                : '左键执行/切换 | 右键设置';
            rightInfo.textContent = 'bennylii · MIT';
            rightInfo.title = '基于 TheNano 的 NTR ToolBox（GreasyFork 527754）功能行为的 clean-room 重构；代码为独立实现，遵循 MIT 许可';
            // 站点自检角标：只在发现「挂点变动」时显示（平时隐藏）
            this.siteCheckEl = document.createElement('span');
            this.siteCheckEl.id = 'ntr-sitecheck';
            this.siteCheckEl.style.display = 'none';
            this.siteCheckEl.style.cursor = 'pointer';
            this.siteCheckEl.style.color = '#E8C46A';
            this.siteCheckEl.onclick = () => SiteCheck.showDetails();
            this.infoBar.appendChild(leftInfo);
            this.infoBar.appendChild(this.siteCheckEl);
            this.infoBar.appendChild(rightInfo);
            this.panel.appendChild(this.infoBar);

            document.body.appendChild(this.panel);

            // 队列状态变化（加任务/开始跑/跑完）时立刻刷新行尾速览，不用等下一次轮询
            GlossaryQueue.setGlanceHook(() => this.refreshQueueGlance(true));

            this.dragHandler = new NTRToolBox.DragHandler(this.panel, this.titleBar);
            this.buildModules();

            // 量两套尺寸（展开/最小化），最小化锚角归位时要用；量完把 minimized 类摘掉还原
            setTimeout(() => {
                this.expandedWidth = this.panel.offsetWidth;
                this.expandedHeight = this.panel.offsetHeight;

                const wasMin = this.isMinimized;
                if (!wasMin) this.panel.classList.add('minimized');
                this.minimizedHeight = this.panel.offsetHeight;
                this.minimizedWidth = this.panel.offsetWidth;
                if (!wasMin) this.panel.classList.remove('minimized');
            }, 150);

            if (IS_MOBILE) {
                // On mobile, single tap toggles minimized state.
                this.titleBar.addEventListener('click', (e) => {
                    if (!this.dragHandler.dragging) {
                        e.preventDefault();
                        this.setMinimizedState(!this.isMinimized);
                    }
                });
            } else {
                this.titleBar.addEventListener('contextmenu', (e) => {
                    e.preventDefault();
                    this.setMinimizedState(!this.isMinimized);
                });
            }
        }

        buildModules() {
            this.panelBody.innerHTML = '';
            this.headerMap.clear();
            this.glanceMap.clear();

            this.configuration.modules.forEach((mod) => {
                const container = document.createElement('div');
                container.className = 'ntr-module-container';

                const header = document.createElement('div');
                header.className = 'ntr-module-header';
                const nameSpan = document.createElement('span');
                nameSpan.textContent = mod.name;
                header.appendChild(nameSpan);
                if (!IS_MOBILE) {
                    const icon = document.createElement('span');
                    icon.textContent = (mod.type === 'keep') ? '⇋' : '▶';
                    icon.style.marginLeft = '8px';
                    header.appendChild(icon);
                }

                // 「术语队列」行尾的速览角标（队列:X | 运行中:Y），由 refreshQueueGlance 定时刷新
                if (mod.name === '术语队列') {
                    const glance = document.createElement('span');
                    glance.className = 'ntr-module-glance';
                    glance.textContent = '|队列:0|运行中:0|';
                    header.appendChild(glance);
                    this.glanceMap.set(mod.name, glance);
                }
                // 「Daemon 连接」行尾状态角标（在线/离线），由 refreshDaemonGlance 节流探测刷新
                if (mod.name === 'Daemon 连接') {
                    const glance = document.createElement('span');
                    glance.className = 'ntr-module-glance';
                    glance.textContent = '|…|';
                    header.appendChild(glance);
                    this.daemonGlanceEl = glance;
                }

                const settingsDiv = document.createElement('div');
                settingsDiv.className = 'ntr-settings-container';
                settingsDiv.style.display = 'none';

                // ---- 下拉选项（分叉）：options 可为函数（如「翻译器」要反映工作区最新列表） ----
                const optionList = (setting) => {
                    const raw = typeof setting.options === 'function' ? setting.options() : setting.options;
                    if (!Array.isArray(raw)) return [];
                    return raw.map((o) => (o && typeof o === 'object')
                        ? { value: String(o.value), label: String(o.label == null ? o.value : o.label) }
                        : { value: String(o), label: String(o) });
                };
                const fillSelect = (el, setting) => {
                    const current = setting.value == null ? '' : String(setting.value);
                    const list = optionList(setting);
                    // 当前值不在选项里（翻译器被删/改名）时补一条，避免选中项凭空丢失
                    if (!list.some((o) => o.value === current)) {
                        list.unshift({ value: current, label: current || '(未设置)' });
                    }
                    el.innerHTML = '';
                    list.forEach((o) => {
                        const opt = document.createElement('option');
                        opt.value = o.value;
                        opt.textContent = o.label;
                        if (o.value === current) opt.selected = true;
                        el.appendChild(opt);
                    });
                };
                let syncGroupsFn = () => { };
                const refreshSelectOptions = () => {
                    settingsDiv.querySelectorAll('select[data-setting-name]').forEach((el) => {
                        const setting = (mod.settings || []).find((x) => x.name === el.dataset.settingName);
                        if (setting) fillSelect(el, setting);
                    });
                    syncGroupsFn();
                };

                // ---- header 交互：桌面 左键执行/右键设置；移动端 单击执行 + ⚙️设置 ----
                const toggleSettings = () => {
                    const opening = window.getComputedStyle(settingsDiv).display === 'none';
                    settingsDiv.style.display = opening ? 'block' : 'none';
                    if (opening) refreshSelectOptions();
                };
                if (IS_MOBILE) {
                    const gear = document.createElement('button');
                    gear.textContent = '⚙️';
                    gear.style.color = 'white';
                    gear.style.float = 'right';
                    gear.onclick = (e) => {
                        e.stopPropagation();
                        toggleSettings();
                    };
                    header.appendChild(gear);

                    header.onclick = (e) => {
                        if (e.target.classList.contains('ntr-bind-button') || e.target === gear) return;
                        const stored = this.configuration.modules.find((m) => m.name === mod.name);
                        NotificationUtils.showSuccess(`运行模块: ${mod.name}`);
                        this.handleModuleClick(stored || mod, header);
                    };
                } else {
                    header.oncontextmenu = (e) => {
                        e.preventDefault();
                        toggleSettings();
                    };
                    header.onclick = (e) => {
                        if (e.button !== 0 || e.ctrlKey || e.altKey || e.shiftKey) return;
                        if (e.target.classList.contains('ntr-bind-button')) return;
                        this.handleModuleClick(mod, header);
                    };
                }

                // ---- 设置行渲染 ----
                if (Array.isArray(mod.settings)) {
                    const groupDefs = Array.isArray(mod.settingGroups) ? mod.settingGroups : [];
                    const renderedGroups = new Set();

                    // 折叠框状态同步：enabledBy 开关没勾 → 整组收起并禁用内部输入
                    const syncGroups = () => {
                        settingsDiv.querySelectorAll('.ntr-settings-group').forEach((box) => {
                            const def = groupDefs.find((x) => x.id === box.dataset.groupId);
                            if (!def) return;
                            const toggle = def.enabledBy
                                ? settingsDiv.querySelector(`input[type=checkbox][data-setting-name="${def.enabledBy}"]`)
                                : null;
                            const enabled = !toggle || toggle.checked;
                            const expanded = enabled && box.dataset.expanded === '1';
                            box.querySelector('.ntr-settings-group-body').style.display = expanded ? 'block' : 'none';
                            box.querySelectorAll('.ntr-settings-group-body input, .ntr-settings-group-body select, .ntr-settings-group-body textarea, .ntr-settings-group-body button')
                                .forEach((el) => { el.disabled = !enabled; });
                            const headEl = box.querySelector('.ntr-settings-group-head');
                            headEl.textContent = `${expanded ? '▾' : '▸'} ${def.title}`;
                            headEl.classList.toggle('disabled', !enabled);
                        });
                    };
                    syncGroupsFn = syncGroups;

                    const createSettingRow = (setting) => {
                        const row = document.createElement('div');
                        row.style.marginBottom = '8px';

                        const label = document.createElement('label');
                        label.style.display = 'inline-block';
                        label.style.minWidth = '70px';
                        label.style.color = '#ccc';
                        label.textContent = setting.name + ': ';
                        row.appendChild(label);

                        let input;
                        switch (setting.type) {
                            case 'boolean': {
                                input = document.createElement('input');
                                input.type = 'checkbox';
                                input.dataset.settingName = setting.name;
                                input.checked = !!setting.value;
                                input.onchange = () => {
                                    setting.value = input.checked;
                                    this.saveConfiguration();
                                    // 开关若控制折叠框：勾上自动展开（好填内容），取消自动收起
                                    settingsDiv.querySelectorAll('.ntr-settings-group').forEach((box) => {
                                        const def = groupDefs.find((x) => x.id === box.dataset.groupId);
                                        if (def && def.enabledBy === setting.name) box.dataset.expanded = input.checked ? '1' : '0';
                                    });
                                    syncGroups();
                                };
                                break;
                            }
                            case 'number': {
                                input = document.createElement('input');
                                input.type = 'number';
                                input.value = setting.value;
                                input.className = 'ntr-number-input';
                                input.onchange = () => {
                                    setting.value = Number(input.value) || 0;
                                    this.saveConfiguration();
                                };
                                break;
                            }
                            case 'select': {
                                input = document.createElement('select');
                                input.dataset.settingName = setting.name;
                                fillSelect(input, setting);
                                // 点开下拉时重新求值：设置面板一直开着也能看到工作区里刚加的翻译器
                                const refill = () => {
                                    fillSelect(input, setting);
                                    input.value = setting.value == null ? '' : String(setting.value);
                                };
                                input.addEventListener('pointerdown', refill);
                                input.addEventListener('focus', refill);
                                input.onchange = () => {
                                    setting.value = input.value;
                                    this.saveConfiguration();
                                };
                                break;
                            }
                            case 'string': {
                                if (setting.name === 'bind') {
                                    // 快捷键捕获按钮：点击后按任意键录入（Escape 清除）
                                    input = document.createElement('button');
                                    input.className = 'ntr-bind-button';
                                    input.textContent = (setting.value === 'none') ? '(None)' : `[${setting.value.toUpperCase()}]`;
                                    input.onclick = () => {
                                        input.textContent = '(Press any key)';
                                        const capture = (ev) => {
                                            ev.preventDefault();
                                            setting.value = (ev.key === 'Escape') ? 'none' : ev.key.toLowerCase();
                                            input.textContent = (setting.value === 'none') ? '(None)' : `[${ev.key.toUpperCase()}]`;
                                            this.saveConfiguration();
                                            document.removeEventListener('keydown', capture, true);
                                            ev.stopPropagation();
                                        };
                                        document.addEventListener('keydown', capture, true);
                                    };
                                } else {
                                    input = document.createElement('input');
                                    input.type = 'text';
                                    input.value = setting.value;
                                    input.className = 'ntr-input';
                                    input.onchange = () => {
                                        setting.value = input.value;
                                        this.saveConfiguration();
                                    };
                                }
                                break;
                            }
                            case 'textarea': {
                                input = document.createElement('textarea');
                                input.value = setting.value;
                                input.className = 'ntr-input';
                                input.style.height = '80px';
                                input.style.width = '180px';
                                input.style.resize = 'vertical';
                                input.onchange = () => {
                                    setting.value = input.value;
                                    this.saveConfiguration();
                                };
                                break;
                            }
                            default: {
                                input = document.createElement('span');
                                input.style.color = '#999';
                                input.textContent = String(setting.value);
                                if (setting.name === '连接状态') input.dataset.role = 'daemon-status';
                            }
                        }
                        row.appendChild(input);
                        return row;
                    };

                    mod.settings.forEach((setting) => {
                        const groupDef = groupDefs.find((x) => x.members.includes(setting.name));
                        if (!groupDef) {
                            settingsDiv.appendChild(createSettingRow(setting));
                            return;
                        }
                        if (renderedGroups.has(groupDef.id)) return;   // 同一组的成员聚在一起渲染
                        renderedGroups.add(groupDef.id);
                        const groupBox = document.createElement('div');
                        groupBox.className = 'ntr-settings-group';
                        groupBox.dataset.groupId = groupDef.id;
                        groupBox.dataset.expanded = '0';
                        const head = document.createElement('div');
                        head.className = 'ntr-settings-group-head';
                        head.onclick = () => {
                            groupBox.dataset.expanded = (groupBox.dataset.expanded === '1') ? '0' : '1';
                            syncGroups();
                        };
                        const body = document.createElement('div');
                        body.className = 'ntr-settings-group-body';
                        body.style.paddingLeft = '10px';
                        body.style.marginTop = '6px';
                        groupDef.members.forEach((memberName) => {
                            const memberSetting = mod.settings.find((x) => x.name === memberName);
                            if (memberSetting) body.appendChild(createSettingRow(memberSetting));
                        });
                        groupBox.appendChild(head);
                        groupBox.appendChild(body);
                        settingsDiv.appendChild(groupBox);
                    });
                    syncGroups();
                }

                container.appendChild(header);
                container.appendChild(settingsDiv);

                this.panelBody.appendChild(container);
                this.headerMap.set(mod, header);
            });
        }

        attachGlobalKeyBindings() {
            document.addEventListener('keydown', (e) => {
                if (e.ctrlKey || e.altKey || e.metaKey) return;
                const pressed = e.key.toLowerCase();
                this.configuration.modules.forEach((mod) => {
                    const bind = mod.settings.find((s) => s.name === 'bind');
                    if (!bind || bind.value === 'none' || bind.value.toLowerCase() !== pressed) return;
                    if (!isModuleEnabledByWhitelist(mod)) return;
                    e.preventDefault();
                    this.handleModuleClick(mod, null);
                });
            });
        }

        // 点击入口。域门槛在这里：非站点域名 / 不在白名单页上一律不动作（自动化测试请走 runModule）
        handleModuleClick(mod, header) {
            if (!domainAllowed || !isModuleEnabledByWhitelist(mod)) return;
            try {
                if (mod.type === 'onclick') {
                    if (typeof mod.run === 'function') {
                        Promise.resolve(mod.run(mod)).catch(console.error);
                    }
                } else if (mod.type === 'keep') {
                    if (this.keepActiveSet.has(mod.name)) {
                        if (header) this.stopKeepModule(mod, header);
                    } else {
                        if (header) this.startKeepModule(mod, header);
                    }
                }
            } catch (err) {
                console.error('Error running module:', mod.name, err);
            }
        }

        startKeepModule(mod, header) {
            if (this.keepActiveSet.has(mod.name)) return;
            header.classList.add('active');
            this.keepActiveSet.add(mod.name);
            this.updateKeepStateStorage();
        }

        stopKeepModule(mod, header) {
            header.classList.remove('active');
            this.keepActiveSet.delete(mod.name);
            this.updateKeepStateStorage();
        }

        updateKeepStateStorage() {
            const state = {};
            this.keepActiveSet.forEach((name) => { state[name] = true; });
            localStorage.setItem('NTR_KeepState', JSON.stringify(state));
        }

        loadKeepStateAndStart() {
            let saved = {};
            try {
                saved = JSON.parse(localStorage.getItem('NTR_KeepState') || '{}');
            } catch (e) { }
            this.configuration.modules.forEach((mod) => {
                if (mod.type !== 'keep' || !saved[mod.name]) return;
                const hdr = this.headerMap.get(mod);
                if (hdr) this.startKeepModule(mod, hdr);
            });
        }

        // 主循环：keep 重跑（≥100ms）→ 显隐与路由（≥250ms）→ 队列速览 → 10ms 后再来一遍
        scheduleNextPoll() {
            const now = Date.now();
            if (now - this._lastKeepRun >= 100) {
                this.pollKeepModules();
                this._lastKeepRun = now;
            }
            if (now - this._lastVisRun >= 250) {
                this.updateModuleVisibility();
                if (this._lastEndPoint !== window.location.href) {
                    StorageUtils.update();
                    this._lastEndPoint = window.location.href;
                    SiteCheck.onRouteChange();
                }
                this._lastVisRun = now;
            }
            this.refreshQueueGlance();
            this.refreshDaemonGlance();
            this._pollTimer = setTimeout(() => {
                this.scheduleNextPoll();
            }, 10);
        }

        // 「Daemon 连接」行尾角标：探测 {base}/ping，30s 节流（无常驻心跳压力）
        // 同一 tick 顺带做「凭据自动同步」：自动同步开 + 在线 + 指纹（token+workers+origin）变化才推送
        refreshDaemonGlance(force) {
            const el = this.daemonGlanceEl;
            if (!el) return;
            const now = Date.now();
            if (!force && now - (this._lastDaemonPing || 0) < 30000) return;
            this._lastDaemonPing = now;
            const mod = this.configuration.modules.find((m) => m.name === 'Daemon 连接');
            const base = mod ? (getModuleSetting(mod, 'Daemon 地址') || '').trim().replace(/\/$/, '') : '';
            if (!base) {
                el.textContent = '|未配置|';
                el.classList.remove('busy');
                el.classList.add('has');
                return;
            }
            daemonProbe(base).then((ping) => {
                if (this.daemonGlanceEl !== el) return;
                if (ping && ping.ok) {
                    el.textContent = '|在线|';
                    el.classList.add('busy');
                    el.classList.remove('has');
                    this.daemonAutoSync(mod);
                } else {
                    el.textContent = '|离线|';
                    el.classList.remove('busy');
                    el.classList.add('has');
                }
            }).catch(() => { });
        }

        // 自动同步：指纹不变则零网络请求；首次静默推；旧指纹变化（token 刷新）推并提示一次
        async daemonAutoSync(mod) {
            if (!mod || this._daemonSyncBusy) return;
            if (getModuleSetting(mod, '自动同步') === false) return;
            const token = daemonReadToken();
            if (!token) return;
            const workers = readWorkspaceGptWorkers();
            const fp = daemonFingerprint(token, workers);
            let prev = null;
            try { prev = localStorage.getItem(DAEMON_FP_KEY); } catch (e) { }
            if (prev === fp) return;
            this._daemonSyncBusy = true;
            try {
                const r = await daemonPushCredentials(mod, { silent: prev === null, auto: true });
                if (r.ok && prev !== null) NotificationUtils.showSuccess('凭据已自动更新到 Daemon');
            } finally {
                this._daemonSyncBusy = false;
            }
        }

        // 「术语队列」行尾速览：队列（待处理）+ 运行中，1s 节流；队列有变化时由 notify() 直接推一次（分叉自有）
        refreshQueueGlance(force) {
            if (!this.glanceMap || this.glanceMap.size === 0) return;
            const now = Date.now();
            if (!force && now - this._lastGlanceRun < 1000) return;
            if (this._glanceBusy) return;
            this._lastGlanceRun = now;
            this._glanceBusy = true;
            GlossaryQueue.counts().then(({ queued, running }) => {
                this.glanceMap.forEach((el) => {
                    el.textContent = `|队列:${queued}|运行中:${running}|`;
                    el.classList.toggle('busy', running > 0);
                    el.classList.toggle('has', running === 0 && queued > 0);
                });
            }).catch(() => { }).then(() => { this._glanceBusy = false; });
        }

        pollKeepModules() {
            for (const mod of this.configuration.modules) {
                if (mod.type !== 'keep') continue;
                if (!this.keepActiveSet.has(mod.name)) continue;
                if (typeof mod.run !== 'function') continue;
                mod.run(mod);
            }
        }

        // 自动化入口：绕过域门槛与白名单，按名直接执行
        runModule(name) {
            for (const mod of this.configuration.modules) {
                if (mod.name != name) continue;
                if (typeof mod.run === 'function') {
                    mod.run(mod, true);
                }
            }
        }

        updateModuleVisibility() {
            this.configuration.modules.forEach((mod) => {
                const hdr = this.headerMap.get(mod);
                if (!hdr) return;
                const allowed = domainAllowed && isModuleEnabledByWhitelist(mod) && !mod.hidden;
                hdr.parentElement.style.display = allowed ? 'block' : 'none';
                if (!allowed && mod.type === 'keep' && this.keepActiveSet.has(mod.name)) {
                    this.stopKeepModule(mod, hdr);
                }
            });
        }

        // 面板中心落在屏幕四象限的哪一块 → 最小化时往那个角贴
        getAnchorCornerInfo(rect) {
            const corner = ((rect.top + rect.height / 2) < window.innerHeight / 2 ? 'top' : 'bottom')
                + '-' + ((rect.left + rect.width / 2) < window.innerWidth / 2 ? 'left' : 'right');
            return {
                corner,
                x: corner.endsWith('-left') ? rect.left : rect.right,
                y: corner.startsWith('top') ? rect.top : rect.bottom,
            };
        }

        // 登录后各角在最小化时的回位坐标：取当前面板 rect 与登记时的锚点，
        // 返回"贴回原角"之后的 [left, top]（px 数值）
        static CORNER_PLACEMENTS = {
            'top-left': (rect, anchor) => [anchor.x, anchor.y],
            'top-right': (rect, anchor) => [anchor.x - rect.width, anchor.y],
            'bottom-left': (rect, anchor) => [anchor.x, anchor.y - rect.height],
            'bottom-right': (rect, anchor) => [anchor.x - rect.width, anchor.y - rect.height],
        };

        setMinimizedState(newVal) {
            if (this.isMinimized === newVal) return;
            const anchor = this.getAnchorCornerInfo(this.panel.getBoundingClientRect());

            this.isMinimized = newVal;
            if (this.isMinimized) {
                this.panel.classList.add('minimized');
                this.toggleSpan.textContent = '[+]';
                this.panelBody.style.display = 'none';
                this.infoBar.style.display = 'none';
            } else {
                this.panel.classList.remove('minimized');
                this.toggleSpan.textContent = '[-]';
                this.panelBody.style.display = 'block';
                this.infoBar.style.display = 'flex';
            }

            // 等 310ms（transition 收尾）再按登记的锚角回位：查表得目标坐标，夹进视口并落盘
            setTimeout(() => {
                const newRect = this.panel.getBoundingClientRect();
                const place = NTRToolBox.CORNER_PLACEMENTS[anchor.corner];
                const [rawLeft, rawTop] = place
                    ? place(newRect, anchor)
                    : [parseFloat(this.panel.style.left) || newRect.left, parseFloat(this.panel.style.top) || newRect.top];
                const left = Math.min(Math.max(rawLeft, 0), window.innerWidth - newRect.width);
                const top = Math.min(Math.max(rawTop, 0), window.innerHeight - newRect.height);
                this.panel.style.left = left + 'px';
                this.panel.style.top = top + 'px';
                localStorage.setItem('ntr-panel-position', JSON.stringify({
                    left: this.panel.style.left,
                    top: this.panel.style.top
                }));
            }, 310);
        }

        // 站点请求通道：token 每次现读（短效 access token 靠 refresh cookie 续期，构造时缓存只是兜底）；
        // options.headers 可以整体覆盖，但缺 Authorization 时补上 Bearer
        async fetch(url, bypass = true, options = {}) {
            const token = this.initToken() || this.token;
            if (!bypass || !token) {
                return fetch(url, options);
            }
            const merged = {
                ...options,
                method: options.method || 'GET',
                headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) },
            };
            return fetch(url, merged);
        }

        delay(ms) {
            // keep 型模块的轮内等待（自动重试的轮间隙等）：到点再继续
            return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
        }
    }

    // -----------------------------------
    // 面板样式（clean-room 重写，契约：docs/cleanroom/spec-05-css-and-shell.md）
    // 选择器是 DOM/e2e 契约、渲染像素级一致；只另起分组、声明次序与注释
    // -----------------------------------
    const css = document.createElement('style');
    css.textContent = `
    /* —— 面板本体 —— */
    #ntr-panel {
      position: fixed;
      left: 20px;
      top: 70px;
      z-index: 9999;
      width: 320px;
      padding: 8px;
      background: #1E1E1E;
      color: #BBB;
      font-family: Arial, sans-serif;
      border: 1px solid #333;
      border-radius: 8px;
      box-shadow: 2px 2px 12px rgba(0,0,0,0.5);
      transition: width 0.3s ease, height 0.3s ease, top 0.3s ease, left 0.3s ease;
    }
    #ntr-panel.minimized {
      width: 200px;
    }
    .ntr-titlebar {
      padding: 10px;
      background: #292929;
      color: #CCC;
      font-weight: bold;
      border-radius: 6px;
      cursor: move;
      user-select: none;
    }
    .ntr-panel-body {
      max-height: 80vh;
      padding: 6px;
      background: #232323;
      border-radius: 4px;
      overflow-y: auto;
      transition: max-height 0.3s ease;
    }
    #ntr-panel.minimized .ntr-panel-body {
      max-height: 0;
    }

    /* —— 模块行 —— */
    .ntr-module-container {
      margin-bottom: 12px;
      border: 1px solid #444;
      border-radius: 4px;
    }
    .ntr-module-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 8px;
      background: #2E2E2E;
      border-bottom: 1px solid #333;
      border-radius: 3px 3px 0 0;
      cursor: pointer;
      transition: background 0.3s;
    }
    .ntr-module-header:hover {
      background: #3a3a3a;
    }
    .ntr-module-header.active {
      background: #63E2B7 !important;
      color: #fff !important;
    }
    /* 「术语队列」行尾速览角标（分叉自有元素） */
    .ntr-module-glance {
      margin-left: auto;
      padding-left: 8px;
      font-size: 11px;
      color: #6f6f6f;
      font-family: Consolas, "Courier New", monospace;
      white-space: nowrap;
    }
    .ntr-module-glance.has { color: #c8a24a; }
    .ntr-module-glance.busy { color: #63b363; }

    /* —— 设置区（settingGroups 折叠框为分叉自有） —— */
    .ntr-settings-container {
      display: none;
      padding: 6px;
      background: #1C1C1C;
    }
    .ntr-settings-group {
      margin-bottom: 8px;
      padding: 6px 8px;
      background: #202020;
      border: 1px solid #3a3a3a;
      border-radius: 4px;
    }
    .ntr-settings-group-head {
      color: #ddd;
      font-size: 12px;
      cursor: pointer;
      user-select: none;
    }
    .ntr-settings-group-head:hover {
      color: #fff;
    }
    .ntr-settings-group-head.disabled {
      color: #888;
    }

    /* —— 输入控件 —— */
    .ntr-input {
      width: 120px;
      padding: 4px;
      background: #2A2A2A;
      color: #FFF;
      border: 1px solid #555;
      border-radius: 4px;
    }
    .ntr-number-input {
      width: 60px;
      padding: 4px;
      background: #2A2A2A;
      color: #FFF;
      border: 1px solid #555;
      border-radius: 4px;
    }
    .ntr-bind-button {
      padding: 4px 8px;
      background: #2A2A2A;
      color: #FFF;
      border: 1px solid #555;
      border-radius: 4px;
      cursor: pointer;
    }

    /* —— 信息栏 —— */
    .ntr-info {
      display: flex;
      justify-content: space-between;
      margin-top: 8px;
      font-size: 10px;
      color: #888;
    }

    /* —— toast 通知 —— */
    .ntr-notification-container {
      position: fixed;
      top: 20px;
      left: 50%;
      z-index: 9999;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      transform: translateX(-50%);
    }
    .ntr-notification-message {
      display: flex;
      align-items: center;
      min-width: 200px;
      margin-top: 8px;
      padding: 4px 8px;
      background-color: #2A2A2A;
      color: #fff;
      font-size: 14px;
      font-family: sans-serif;
      border-radius: 4px;
      opacity: 1;
      transition: opacity 0.3s ease;
    }
    .ntr-notification-message .ntr-icon {
      margin-right: 4px;
      font-size: 16px;
    }
    .ntr-notification-message.fade-out {
      opacity: 0;
    }

    /* —— 术语表填充徽章 —— */
    .ntr-glossary-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      margin-right: 6px;
      font-size: 12px;
      border-radius: 50%;
      cursor: help;
      flex-shrink: 0;
      transition: all 0.3s ease;
    }
    .ntr-glossary-pending {
      background: linear-gradient(135deg, #fbbf24, #f59e0b);
      animation: nta-pulse 1.5s infinite;
    }
    .ntr-glossary-success {
      background: linear-gradient(135deg, #4ade80, #22c55e);
      box-shadow: 0 0 8px rgba(34, 197, 94, 0.5);
    }
    .ntr-glossary-fail {
      background: linear-gradient(135deg, #ef4444, #dc2626);
      box-shadow: 0 0 8px rgba(220, 38, 38, 0.5);
    }
    @keyframes nta-pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(0.9); opacity: 0.7; }
    }

    /* —— 窄屏缩放 —— */
    @media only screen and (max-width:600px) {
      #ntr-panel {
        transform: scale(0.6);
        transform-origin: top left;
      }
    }
    `;
    document.head.appendChild(css);

    // -----------------------------------
    // Init Script
    // -----------------------------------
    const script = new NTRToolBox();
    // 「调试日志」开关：日志模块自己去读模块设置（队列/引擎都在用它，避免到处传 cfg）
    GlossaryLog.setEnabledSource(() => {
        try {
            const mod = (script.configuration.modules || []).find((m) => m.name === 'AI提取术语表');
            const setting = mod && (mod.settings || []).find((s) => s.name === '调试日志');
            return !!(setting && setting.value);
        } catch (e) { return false; }
    });
    // 调试句柄（控制台/自动化测试用，不影响正常逻辑）
    window._NTRToolBox = script;
    window._NTRGlossaryDev = {
        GlossaryEngine,
        GlossaryUI,
        GlossaryTargets,
        GlossaryDB,
        GlossaryQueue,
        GlossaryLog,
        SiteCheck,
        resolveGlossaryWorkers,
        resolveGlossaryTarget,
        loadGlossarySourceText,
        runGlossaryExtraction,
        writeGlossaryMerged,
        parseGlossaryText,
        parseGlossaryEntries,
        syncWorkspaceTranslators,
        GlossaryReport,
        GlossaryFix,
        loadGlossaryParallelText,
        loadGlossaryAlignedPairs,
        writeBackChapterFixes,
        deriveSeeds: GlossaryEngine.deriveSeeds,
        buildSeedChunks: GlossaryEngine.buildSeedChunks,
        deriveCommonLiteralRoots: GlossaryEngine.deriveCommonLiteralRoots,
        verifyRootCoverage: GlossaryEngine.verifyRootCoverage,
    };
    // 队列自动续跑（含刷新后接管中断任务）
    GlossaryQueue.init(script);
})();
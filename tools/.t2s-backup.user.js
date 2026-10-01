// ==UserScript==
// @name         NTR ToolBox
// @namespace    http://tampermonkey.net/
// @version      v0.7.2
// @author       TheNano
// @description  ToolBox for Novel Translate bot website
// @match        https://books.fishhawk.top/*
// @match        https://books1.fishhawk.top/*
// @match        https://n.novelia.cc/*
// @icon         https://github.com/LittleSurvival/NTR-ToolBox/blob/main/icon.jpg?raw=true
// @grant        GM_openInTab
// @license      All Rights Reserved
// @downloadURL https://update.greasyfork.org/scripts/527754/NTR%20ToolBox.user.js
// @updateURL https://update.greasyfork.org/scripts/527754/NTR%20ToolBox.meta.js
// ==/UserScript==

(function () {
    'use strict';

    if (window._NTRToolBoxInstance) {
        return;
    }

    window._NTRToolBoxInstance = true;

    const CONFIG_VERSION = 23;
    const VERSION = 'v0.7.2';
    const CONFIG_STORAGE_KEY = 'NTR_ToolBox_Config';
    const IS_MOBILE = /Mobi|Android/i.test(navigator.userAgent);
    const domainAllowed = (location.hostname === 'books.fishhawk.top' || location.hostname === 'books1.fishhawk.top' || location.hostname === 'n.novelia.cc');

    // -----------------------------------
    // Module settings
    // -----------------------------------

    function newBooleanSetting(nameDefault, boolDefault) {
        return { name: nameDefault, type: 'boolean', value: Boolean(boolDefault) };
    }
    function newNumberSetting(nameDefault, numDefault) {
        return { name: nameDefault, type: 'number', value: Number(numDefault || 0) };
    }
    function newStringSetting(nameDefault, strDefault) {
        return { name: nameDefault, type: 'string', value: String(strDefault == null ? '' : strDefault) };
    }
    function newSelectSetting(nameDefault, arrOptions, valDefault) {
        return { name: nameDefault, type: 'select', value: valDefault, options: arrOptions };
    }
    function newTextareaSetting(nameDefault, strDefault) {
        return { name: nameDefault, type: 'textarea', value: String(strDefault == null ? '' : strDefault) };
    }
    function getModuleSetting(mod, key) {
        if (!mod.settings) return undefined;
        const found = mod.settings.find(s => s.name === key);
        return found ? found.value : undefined;
    }
    function isModuleEnabledByWhitelist(modItem) {
        if (!modItem.whitelist) {
            return domainAllowed;
        }
        const whitelist = modItem.whitelist;
        const parts = Array.isArray(whitelist) ? whitelist : [whitelist];
        return domainAllowed && parts.some(p => {
            if (typeof p === 'string') {
                if (p.endsWith('/*')) {
                    const base = p.slice(0, -2);
                    return location.pathname.startsWith(base) || location.pathname === base;
                }
                return location.pathname.includes(p);
            }
            return false;
        });
    }

    // -----------------------------------
    // Module definitions
    // -----------------------------------
    const moduleAddSakuraTranslator = {
        name: '添加Sakura翻譯器',
        type: 'onclick',
        whitelist: '/workspace/sakura',
        settings: [
            newNumberSetting('數量', 5),
            newStringSetting('名稱', 'NTR translator '),
            newStringSetting('鏈接', 'https://sakura-share.one'),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            const totalCount = getModuleSetting(cfg, '數量') || 1;
            const namePrefix = getModuleSetting(cfg, '名稱') || '';
            const linkValue = getModuleSetting(cfg, '鏈接') || '';

            StorageUtils.addSakuraWorker(namePrefix, linkValue, totalCount);
        }
    }

    const moduleAddGPTTranslator = {
        name: '添加GPT翻譯器',
        type: 'onclick',
        whitelist: '/workspace/gpt',
        settings: [
            newNumberSetting('數量', 5),
            newStringSetting('名稱', 'NTR translator '),
            newStringSetting('模型', 'deepseek-chat'),
            newStringSetting('鏈接', 'https://api.deepseek.com'),
            newStringSetting('Key', 'sk-wait-for-input'),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            const totalCount = getModuleSetting(cfg, '數量') || 1;
            const namePrefix = getModuleSetting(cfg, '名稱') || '';
            const model = getModuleSetting(cfg, '模型') || '';
            const apiKey = getModuleSetting(cfg, 'Key') || '';
            const apiUrl = getModuleSetting(cfg, '鏈接') || '';

            StorageUtils.addGPTWorker(namePrefix, model, apiUrl, apiKey, totalCount);
        }
    };

    const moduleDeleteTranslator = {
        name: '刪除翻譯器',
        type: 'onclick',
        whitelist: '/workspace',
        settings: [
            newBooleanSetting('確認刪除', true),
            newStringSetting('排除', '共享,本机,AutoDL'),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            const confirmDelete = getModuleSetting(cfg, '確認刪除');
            const excludeStr = getModuleSetting(cfg, '排除') || '';
            const excludeArr = excludeStr.split(',').filter(x => x);

            // Get current workers to show count
            let currentWorkers = [];
            const key = location.href.endsWith('gpt') ? StorageUtils.gpt : (location.href.endsWith('sakura') ? StorageUtils.sakura : null);
            if (key) {
                const data = await StorageUtils._getData(key);
                currentWorkers = data.workers.filter(w => !excludeArr.includes(w.id));
            }

            if (confirmDelete && currentWorkers.length > 0) {
                if (!confirm(`確定要刪除 ${currentWorkers.length} 個翻譯器嗎？`)) {
                    NotificationUtils.showWarning('已取消刪除');
                    return;
                }
            }

            if (location.href.endsWith('gpt')) {
                await StorageUtils.removeAllWorkers(StorageUtils.gpt, excludeArr);
                NotificationUtils.showSuccess('已刪除 GPT 翻譯器');
            } else if (location.href.endsWith('sakura')) {
                await StorageUtils.removeAllWorkers(StorageUtils.sakura, excludeArr);
                NotificationUtils.showSuccess('已刪除 Sakura 翻譯器');
            }
        }
    };

    const moduleLaunchTranslator = {
        name: '啟動翻譯器',
        type: 'onclick',
        whitelist: '/workspace',
        settings: [
            newNumberSetting('延遲間隔', 50),
            newNumberSetting('最多啟動', 999),
            newBooleanSetting('避免無效啟動', true),
            newStringSetting('排除', '本机,AutoDL'),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg, auto) {
            const intervalVal = getModuleSetting(cfg, '延遲間隔') || 50;
            const maxClick = getModuleSetting(cfg, '最多啟動') || 999;
            const noEmptyLaunch = getModuleSetting(cfg, '避免無效啟動');
            const allBtns = [...document.querySelectorAll('button')].filter(btn => {
                if (!auto && noEmptyLaunch) return true;
                const listItem = btn.closest('.n-list-item');
                if (listItem) {
                    const errorMessages = listItem.querySelectorAll('div');
                    return !Array.from(errorMessages).some(div => div.textContent.includes("TypeError: Failed to fetch"));
                }
                return true;
            });
            const delay = ms => new Promise(r => setTimeout(r, ms));
            let idx = 0, clickCount = 0, lastRunning = 0, emptyCheck = 0;

            async function nextClick() {
                while (idx < allBtns.length && clickCount < maxClick) {
                    const btn = allBtns[idx++];
                    if (btn.textContent.includes('启动')) {
                        btn.click();
                        clickCount++;
                        await delay(intervalVal);
                    }
                    if (noEmptyLaunch) {
                        let running = [...document.querySelectorAll('button')].filter(btn => btn.textContent.includes('停止')).length;
                        if (running == lastRunning) emptyCheck++;
                        if (emptyCheck > 3) break;
                    }
                }
            }
            await nextClick();
        }
    };

    const moduleQueueSakuraV2 = {
        name: '排隊Sakura v2',
        type: 'onclick',
        whitelist: ['/wenku', '/novel', '/favorite'],
        progress: { percentage: 0, info: '' },
        settings: [
            newNumberSetting('單次擷取web數量(可破限)', 20),
            newNumberSetting('擷取單頁wenku數量(deving)', 20),
            newSelectSetting('模式', ['常規', '過期', '重翻'], '常規'),
            newSelectSetting('分段', ['智能', '固定'], '智能'),
            newNumberSetting('智能均分任務上限', 1000),
            newNumberSetting('智能均分章節下限', 5),
            newNumberSetting('固定均分任務', 6),
            newBooleanSetting('R18(需登入)', true),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            const webCatchLimit = getModuleSetting(cfg, '單次擷取web數量(可破限)') || 20;
            const wenkuCatchLimit = getModuleSetting(cfg, '擷取單頁wenku數量(deving)') || 20;
            const pair = getModuleSetting(cfg, '固定均分任務') || 6;
            const smartJobLimit = getModuleSetting(cfg, '智能均分任務上限') || 1000;
            const smartChapterLimit = getModuleSetting(cfg, '智能均分章節下限') || 5;
            const type = TaskUtils.getTypeString(window.location.pathname);
            const mode = getModuleSetting(cfg, '模式') || '常規';
            const sepMode = getModuleSetting(cfg, '分段') || '智能';
            const r18Bypass = getModuleSetting(cfg, 'R18(需登入)');

            let results = [];
            let errorFlag = false;
            const maxRetries = 3;

            const modeMap = { '常規': '常规', '過期': '过期', '重翻': '重翻' };
            const cnMode = modeMap[mode] || '常规';
            const translateMode = SettingUtils.getTranslateMode(mode);

            switch (type) {
                case 'wenkus': {
                    const wenkuIds = TaskUtils.wenkuIds();
                    const apiEndpoint = `/api/wenku/`;

                    await Promise.all(
                        wenkuIds.map(async (id) => {
                            let attempts = 0;
                            let success = false;

                            while (attempts < maxRetries && !success) {
                                try {
                                    const response = await script.fetch(`${window.location.origin}${apiEndpoint}${id}`, r18Bypass);
                                    if (!response.ok) throw new Error('Network response was not ok');
                                    const data = await response.json();
                                    const volumeIds = data.volumeJp.map(volume => volume.volumeId);

                                    volumeIds.forEach(name => results.push({ task: TaskUtils.wenkuLinkBuilder(id, name, translateMode), description: name }))
                                    success = true;
                                } catch (error) {
                                    NotificationUtils.showError(`Failed to fetch data for ID ${id}, attempt ${attempts + 1}.`);
                                    attempts++;
                                    if (attempts < maxRetries) {
                                        await new Promise(resolve => setTimeout(resolve, 1000));
                                    }
                                }
                            }
                        })
                    );
                    await StorageUtils.addJobs(StorageUtils.sakura, results);
                    break;
                };
                case 'wenku': {
                    await TaskUtils.clickButtons(cnMode);
                    await TaskUtils.clickButtons('排队Sakura');
                    break;
                }
                case 'novels': {
                    const apiUrl = TaskUtils.webSearchApi(webCatchLimit);
                    try {
                        const response = await script.fetch(`${window.location.origin}${apiUrl}`, r18Bypass);
                        if (!response.ok) throw new Error('Network response was not ok');
                        const data = await response.json();
                        const novels = data.items.map(item => {
                            const title = item.titleZh ?? item.titleJp;
                            return {
                                url: `/${item.providerId}/${item.novelId}`,
                                description: title,
                                total: item.total,
                                sakura: item.sakura
                            };
                        });
                        results = sepMode == '智能'
                            ? await TaskUtils.assignTasksSmart(novels, smartJobLimit, smartChapterLimit, translateMode)
                            : await TaskUtils.assignTasksStatic(novels, pair, translateMode);

                        await StorageUtils.addJobs(StorageUtils.sakura, results);
                    } catch (error) {
                        errorFlag = true;
                        NotificationUtils.showError(`Failed to fetch web search results.`);
                    }
                    break;
                }
                case 'novel': {
                    try {
                        const targetSpan = Array.from(document.querySelectorAll('span.n-text')).find(span => /总计 (\d+) \/ 百度 (\d+) \/ 有道 (\d+) \/ GPT (\d+) \/ Sakura (\d+)/.test(span.textContent));
                        if (!targetSpan) {
                            throw Error('无法找到统计信息');
                        }
                        const [_, total, , , , sakura] = targetSpan.textContent.match(/总计 (\d+) \/ 百度 (\d+) \/ 有道 (\d+) \/ GPT (\d+) \/ Sakura (\d+)/);
                        const url = window.location.pathname.split('/novel')[1];
                        const title = document.title;
                        if (title.includes('轻小说机翻机器人')) throw Error('小說頁尚未載入');

                        const novels = [{ url: url, total: total, sakura: sakura, description: title }];
                        results = sepMode == '智能'
                            ? await TaskUtils.assignTasksSmart(novels, smartJobLimit, smartChapterLimit, translateMode)
                            : await TaskUtils.assignTasksStatic(novels, pair, translateMode);

                        await StorageUtils.addJobs(StorageUtils.sakura, results);
                    } catch (error) {
                        errorFlag = true;
                        NotificationUtils.showError(`Failed to fetch data for ${title}.`);
                    }
                    break;
                }
                case 'favorite-web': {
                    const url = new URL(window.location.href);
                    //get folder id
                    const id = url.pathname.endsWith('/web') ? 'default' : url.pathname.split('/').pop();
                    let tries = 0;
                    let page = 0;

                    while (true) {
                        const apiUrl = `${url.origin}/api/user/favored-web/${id}?page=${page}&pageSize=90&sort=update`;
                        let tasks = [];
                        let novelCount = 0;
                        try {
                            const response = await script.fetch(apiUrl);
                            const data = await response.json();
                            const novels = data.items.map(item => {
                                const title = item.titleZh ?? item.titleJp;
                                return {
                                    url: `/${item.providerId}/${item.novelId}`,
                                    description: title,
                                    total: item.total,
                                    sakura: item.sakura
                                };
                            });
                            novelCount = novels.length;
                            tasks = sepMode == '智能'
                                ? await TaskUtils.assignTasksSmart(novels, smartJobLimit, smartChapterLimit, translateMode)
                                : await TaskUtils.assignTasksStatic(novels, pair, translateMode);

                            await StorageUtils.addJobs(StorageUtils.sakura, tasks);
                            results.push(...tasks);
                            NotificationUtils.showSuccess(`成功排隊 ${3 * page + 1}-${3 * page + 3}頁, 共${tasks.length}個任務`);
                        } catch (error) {
                            console.log(error);
                            NotificationUtils.showError(`Failed to fetch data for ${id}, page ${page + 1}.`);
                            if (tries++ > 3) break;
                            continue;
                        }
                        if (novelCount < 90) break;
                        else page++;
                    }
                    break;
                }
                case 'favorite-wenku': {
                    const url = new URL(window.location.href);
                    //get folder id
                    const id = url.pathname.endsWith('/wenku') ? 'default' : url.pathname.split('/').pop();
                    let page = 0;
                    let tries = 0;
                    while (true) {
                        const apiUrl = `${url.origin}/api/user/favored-wenku/${id}?page=${page}&pageSize=72&sort=update`;
                        let tasks = [];
                        let novelCount = 0;
                        try {
                            const response = await script.fetch(apiUrl);
                            const data = await response.json();
                            const wenkuIds = data.items.map(novel => novel.id);
                            novelCount = wenkuIds.length;

                            await Promise.all(
                                wenkuIds.map(async (id) => {
                                    let attempts = 0;
                                    let success = false;
                                    const apiEndpoint = `/api/wenku/`;

                                    while (attempts < maxRetries && !success) {
                                        try {
                                            const response = await script.fetch(`${window.location.origin}${apiEndpoint}${id}`, r18Bypass);
                                            if (!response.ok) throw new Error('Network response was not ok');
                                            const data = await response.json();
                                            const volumeIds = data.volumeJp.map(volume => volume.volumeId);

                                            volumeIds.forEach(name => tasks.push({ task: TaskUtils.wenkuLinkBuilder(id, name, translateMode), description: name }))
                                            success = true;
                                        } catch (error) {
                                            NotificationUtils.showError(`Failed to fetch data for ID ${id}, attempt ${attempts + 1}:`);
                                            attempts++;
                                            if (attempts < maxRetries) {
                                                await new Promise(resolve => setTimeout(resolve, 1000));
                                            }
                                        }
                                    }
                                })
                            );
                            await StorageUtils.addJobs(StorageUtils.sakura, tasks);
                            results.push(...tasks);
                            NotificationUtils.showSuccess(`成功排隊 ${3 * page + 1}-${3 * page + 3}頁, 共${tasks.length}本小說`);
                        } catch (error) {
                            console.log(error);
                            NotificationUtils.showError(`Failed to fetch data for ${id}, page ${page + 1}.`);
                            if (tries > 3) break;
                            continue;
                        }
                        if (novelCount < 72) break;
                        else page++;
                    }
                    break;
                }
                default: { }
            }
            if (errorFlag) return;
            // Fix: Properly filter unique novels by description
            const uniqueNovels = new Set(results.map(result => result.description));
            NotificationUtils.showSuccess(`排隊成功 : 共 ${uniqueNovels.size} 本小說, 均分 ${results.length} 分段.`);
        }
    }

    const moduleQueueGPTV2 = {
        name: '排隊GPT v2',
        type: 'onclick',
        whitelist: ['/wenku', '/novel', '/favorite/web'],
        progress: { percentage: 0, info: '' },
        settings: [
            newNumberSetting('單次擷取web數量(可破限)', 20),
            newNumberSetting('擷取單頁wenku數量(deving)', 20),
            newSelectSetting('模式', ['常規', '過期', '重翻'], '常規'),
            newSelectSetting('分段', ['智能', '固定'], '智能'),
            newNumberSetting('智能均分任務上限', 1000),
            newNumberSetting('智能均分章節下限', 5),
            newNumberSetting('固定均分任務', 6),
            newBooleanSetting('R18(需登入)', true),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            const webCatchLimit = getModuleSetting(cfg, '單次擷取web數量(可破限)') || 20;
            const wenkuCatchLimit = getModuleSetting(cfg, '擷取單頁wenku數量(deving)') || 20;
            const pair = getModuleSetting(cfg, '固定均分任務') || 6;
            const smartJobLimit = getModuleSetting(cfg, '智能均分任務上限') || 1000;
            const smartChapterLimit = getModuleSetting(cfg, '智能均分章節下限') || 5;
            const type = TaskUtils.getTypeString(window.location.pathname);
            const mode = getModuleSetting(cfg, '模式') || '常規';
            const sepMode = getModuleSetting(cfg, '分段') || '智能';
            const r18Bypass = getModuleSetting(cfg, 'R18(需登入)');

            let results = [];
            const maxRetries = 3;
            let errorFlag = false;

            const modeMap = { '常規': '常规', '過期': '过期', '重翻': '重翻' };
            const cnMode = modeMap[mode] || '常规';
            const translateMode = SettingUtils.getTranslateMode(mode);


            switch (type) {
                case 'wenkus': {
                    const wenkuIds = TaskUtils.wenkuIds();
                    const apiEndpoint = `/api/wenku/`;

                    await Promise.all(
                        wenkuIds.map(async (id) => {
                            let attempts = 0;
                            let success = false;

                            while (attempts < maxRetries && !success) {
                                try {
                                    const response = await script.fetch(`${window.location.origin}${apiEndpoint}${id}`, r18Bypass);
                                    if (!response.ok) throw new Error('Network response was not ok');
                                    const data = await response.json();
                                    const volumeIds = data.volumeJp.map(volume => volume.volumeId);

                                    volumeIds.forEach(name => results.push({ task: TaskUtils.wenkuLinkBuilder(id, name, translateMode), description: name }))
                                    success = true;
                                } catch (error) {
                                    NotificationUtils.showError(`Failed to fetch data for ID ${id}, attempt ${attempts + 1}:`);
                                    attempts++;
                                    if (attempts < maxRetries) {
                                        await new Promise(resolve => setTimeout(resolve, 1000));
                                    }
                                }
                            }
                        })
                    );
                    await StorageUtils.addJobs(StorageUtils.gpt, results);
                    break;
                };
                case 'wenku': {
                    await TaskUtils.clickButtons(cnMode);
                    await TaskUtils.clickButtons('排队GPT');
                    break;
                }
                case 'novels': {
                    const apiUrl = TaskUtils.webSearchApi(webCatchLimit);
                    try {
                        const response = await script.fetch(`${window.location.origin}${apiUrl}`, r18Bypass)
                        if (!response.ok) throw new Error('Network response was not ok');
                        const data = await response.json();
                        const novels = data.items.map(item => {
                            const title = item.titleZh ?? item.titleJp;
                            return {
                                url: `/${item.providerId}/${item.novelId}`,
                                description: title,
                                total: item.total,
                                gpt: item.gpt
                            };
                        });
                        results = sepMode == '智能'
                            ? await TaskUtils.assignTasksSmart(novels, smartJobLimit, smartChapterLimit, translateMode)
                            : await TaskUtils.assignTasksStatic(novels, pair, translateMode);

                        await StorageUtils.addJobs(StorageUtils.gpt, results);
                    } catch (error) {
                        errorFlag = true;
                        NotificationUtils.showError(`Failed to fetch web search results.`);
                    }
                    break;
                }
                case 'novel': {
                    try {
                        const targetSpan = Array.from(document.querySelectorAll('span.n-text')).find(span => /总计 (\d+) \/ 百度 (\d+) \/ 有道 (\d+) \/ GPT (\d+) \/ Sakura (\d+)/.test(span.textContent));
                        if (!targetSpan) {
                            throw Error('无法找到统计信息');
                        }
                        const [_, total, , , gpt] = targetSpan.textContent.match(/总计 (\d+) \/ 百度 (\d+) \/ 有道 (\d+) \/ GPT (\d+) \/ Sakura (\d+)/);
                        const url = window.location.pathname.split('/novel')[1];

                        const title = document.title;
                        if (title.includes('轻小说机翻机器人')) throw Error('小說頁尚未載入');

                        const novels = [{ url: url, total: total, gpt: gpt, description: title }]

                        results = sepMode == '智能'
                            ? await TaskUtils.assignTasksSmart(novels, smartJobLimit, smartChapterLimit, translateMode)
                            : await TaskUtils.assignTasksStatic(novels, pair, translateMode);

                        await StorageUtils.addJobs(StorageUtils.gpt, results);
                    } catch (error) {
                        errorFlag = true;
                        NotificationUtils.showError(`Failed to fetch data for ${title}.`);
                    }
                    break;
                }
                case 'favorite-web': {
                    const url = new URL(window.location.href);
                    //get folder id
                    const id = url.pathname.endsWith('/web') ? 'default' : url.pathname.split('/').pop();
                    let tries = 0;
                    let page = 0;

                    while (true) {
                        const apiUrl = `${url.origin}/api/user/favored-web/${id}?page=${page}&pageSize=90&sort=update`;
                        let tasks = [];
                        let novelCount = 0;
                        try {
                            const response = await script.fetch(apiUrl);
                            const data = await response.json();
                            const novels = data.items.map(item => {
                                const title = item.titleZh ?? item.titleJp;
                                return {
                                    url: `/${item.providerId}/${item.novelId}`,
                                    description: title,
                                    total: item.total,
                                    gpt: item.gpt
                                };
                            });
                            novelCount = novels.length;
                            tasks = sepMode == '智能'
                                ? await TaskUtils.assignTasksSmart(novels, smartJobLimit, smartChapterLimit, translateMode)
                                : await TaskUtils.assignTasksStatic(novels, pair, translateMode);

                            await StorageUtils.addJobs(StorageUtils.gpt, tasks);
                            results.push(...tasks);
                            NotificationUtils.showSuccess(`成功排隊 ${3 * page + 1}-${3 * page + 3}頁, 共${novelCount}本小說`);
                        } catch (error) {
                            console.log(error);
                            NotificationUtils.showError(`Failed to fetch data for ${id}, page ${page + 1}.`);
                            if (tries++ > 3) break;
                            continue;
                        }
                        if (novelCount < 90) break;
                        else page++;
                    }
                    break;
                }
                case 'favorite-wenku': {
                    const url = new URL(window.location.href);
                    //get folder id
                    const id = url.pathname.endsWith('/wenku') ? 'default' : url.pathname.split('/').pop();
                    let page = 0;
                    let tries = 0;
                    while (true) {
                        const apiUrl = `${url.origin}/api/user/favored-wenku/${id}?page=${page}&pageSize=72&sort=update`;
                        let tasks = [];
                        let novelCount = 0;
                        try {
                            const response = await script.fetch(apiUrl);
                            const data = await response.json();
                            const wenkuIds = data.items.map(novel => novel.id);
                            novelCount = wenkuIds.length;

                            await Promise.all(
                                wenkuIds.map(async (id) => {
                                    let attempts = 0;
                                    let success = false;
                                    const apiEndpoint = `/api/wenku/`;

                                    while (attempts < maxRetries && !success) {
                                        try {
                                            const response = await script.fetch(`${window.location.origin}${apiEndpoint}${id}`, r18Bypass);
                                            if (!response.ok) throw new Error('Network response was not ok');
                                            const data = await response.json();
                                            const volumeIds = data.volumeJp.map(volume => volume.volumeId);

                                            volumeIds.forEach(name => tasks.push({ task: TaskUtils.wenkuLinkBuilder(id, name, translateMode), description: name }))
                                            success = true;
                                        } catch (error) {
                                            NotificationUtils.showError(`Failed to fetch data for ID ${id}, attempt ${attempts + 1}:`);
                                            attempts++;
                                            if (attempts < maxRetries) {
                                                await new Promise(resolve => setTimeout(resolve, 1000));
                                            }
                                        }
                                    }
                                })
                            );
                            await StorageUtils.addJobs(StorageUtils.gpt, tasks);
                            results.push(...tasks);
                            NotificationUtils.showSuccess(`成功排隊 ${3 * page + 1}-${3 * page + 3}頁, 共${tasks.length}本小說`);
                        } catch (error) {
                            console.log(error);
                            NotificationUtils.showError(`Failed to fetch data for ${id}, page ${page + 1}.`);
                            if (tries > 3) break;
                            continue;
                        }
                        if (novelCount < 72) break;
                        else page++;
                    }
                    break;
                }
                default: { }
            }
            if (errorFlag) return;
            // Fix: Properly filter unique novels by description
            const uniqueNovels = new Set(results.map(result => result.description));
            NotificationUtils.showSuccess(`排隊成功 : 共 ${uniqueNovels.size} 本小說, 均分 ${results.length} 分段.`);
        }
    }

    const moduleAutoRetry = {
        name: '自動重試',
        type: 'keep',
        whitelist: '/workspace/*',
        settings: [
            newNumberSetting('最大重試次數', 99),
            newBooleanSetting('置頂重試任務', false),
            newBooleanSetting('重啟翻譯器', true),
        ],
        _attempts: 0,
        _lastRun: 0,
        _interval: 1000,
        run: async function (cfg) {
            const now = Date.now();
            if (now - this._lastRun < this._interval) return;
            this._lastRun = now;

            const maxAttempts = getModuleSetting(cfg, '最大重試次數') || 99;
            const relaunch = getModuleSetting(cfg, '重啟翻譯器') || 3;
            const moveToTop = getModuleSetting(cfg, '置頂重試任務');

            if (!this._boundClickHandler) {
                this._boundClickHandler = (e) => {
                    if (e.target.tagName === 'button') {
                        this._attempts = 0;
                    }
                };
                document.addEventListener('click', this._boundClickHandler);
            }

            const listItems = document.querySelectorAll('.n-list-item');
            const unfinished = [...listItems].filter(item => {
                const desc = item.querySelector('.n-thing-main__description');
                return desc && desc.textContent.includes('未完成');
            });
            async function retryTasks(attempts) {
                const hasStop = [...document.querySelectorAll('button')].some(b => b.textContent === '停止');
                if (!hasStop) {
                    const retryBtns = [...document.querySelectorAll('button')].filter(b => b.textContent.includes('重试未完成任务'));
                    if (retryBtns[0]) {
                        const clickCount = Math.min(unfinished.length, listItems.length);
                        for (let i = 0; i < clickCount; i++) {
                            retryBtns[0].click();
                        }
                        if (moveToTop) {
                            TaskUtils.clickTaskMoveToTop(unfinished.length);
                        }
                        attempts++;
                    }
                }
                return attempts;
            }

            if (unfinished.length > 0 && this._attempts < maxAttempts) {
                this._attempts = await retryTasks(this._attempts);
                script.delay(10);
                if (relaunch) {
                    script.runModule('啟動翻譯器');
                }
            }
        }
    };

    const moduleClearJobs = {
        name: '清空任務',
        type: 'onclick',
        whitelist: '/workspace/*',
        settings: [
            newBooleanSetting('確認清空', true),
            newBooleanSetting('僅清空已完成', false),
        ],
        run: async function (cfg) {
            const confirmClear = getModuleSetting(cfg, '確認清空');
            const onlyCompleted = getModuleSetting(cfg, '僅清空已完成');
            
            const key = window.location.pathname.includes('workspace/sakura') ? StorageUtils.sakura : 
                        (window.location.pathname.includes('workspace/gpt') ? StorageUtils.gpt : null);
            
            if (!key) {
                NotificationUtils.showError('無法確定工作區類型');
                return;
            }

            const data = await StorageUtils._getData(key);
            
            let jobsToRemove = [];
            if (onlyCompleted) {
                // 只清空已完成的 jobs（需要根据实际数据结构判断）
                // 假设 jobs 中有 status 字段或通过其他方式判断
                NotificationUtils.showWarning('僅清空已完成功能需配合網站API');
                return;
            } else {
                jobsToRemove = data.jobs;
            }

            if (confirmClear && jobsToRemove.length > 0) {
                if (!confirm(`確定要清空 ${jobsToRemove.length} 個任務嗎？此操作不可恢復！`)) {
                    NotificationUtils.showWarning('已取消清空');
                    return;
                }
            }

            data.jobs = [];
            await StorageUtils._setData(key, data);
            NotificationUtils.showSuccess(`已清空 ${jobsToRemove.length} 個任務`);
        }
    };

    const moduleSyncStorage = {
        name: '資料同步',
        type: 'onclick',
        whitelist: '/workspace/*',
        hidden: true,
        settings: [
            newStringSetting('bind', 'none')
        ],
        run: async function (cfg) {
        }
    }

    const moduleFillGlossary = {
        name: '填充术语表',
        type: 'onclick',
        whitelist: '/novel',
        settings: [
            newTextareaSetting('术语表', ''),
            newBooleanSetting('追加模式', true),
            newBooleanSetting('页面可视化反馈', true),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            const glossaryText = getModuleSetting(cfg, '术语表') || '';
            const isAppend = getModuleSetting(cfg, '追加模式');
            const visualFeedback = getModuleSetting(cfg, '页面可视化反馈');
            
            if (!glossaryText.trim()) {
                NotificationUtils.showWarning('术语表为空');
                return;
            }

            // Parse glossary
            const newGlossary = {};
            const delimiter = '=>';
            glossaryText.split('\n').forEach(line => {
                line = line.trim();
                if (!line) return;
                const parts = line.split(delimiter);
                if (parts.length === 2) {
                    newGlossary[parts[0].trim()] = parts[1].trim();
                } else {
                    try {
                        const obj = JSON.parse(line);
                        if (typeof obj === 'object') {
                            Object.assign(newGlossary, obj);
                        }
                    } catch (e) { }
                }
            });

            if (Object.keys(newGlossary).length === 0) {
                NotificationUtils.showError('未能解析任何术语 (格式: 日文 => 中文)');
                return;
            }

            // Find all novels on page and their DOM containers
            const links = [...document.querySelectorAll('a')];
            const novels = [];
            const seen = new Set();
            links.forEach(a => {
                try {
                    const url = new URL(a.href);
                    if (url.origin !== window.location.origin) return;
                    const match = url.pathname.match(/^\/novel\/([^/]+)\/([^/]+)$/);
                    if (match) {
                        const id = `${match[1]}/${match[2]}`;
                        if (!seen.has(id)) {
                            // Try to find the closest list item or card container
                            let container = a.closest('n-list-item');
                            if (!container) {
                                container = a.closest('.n-list-item');
                            }
                            if (!container) {
                                container = a.closest('.novel-card');
                            }
                            if (!container) {
                                container = a.closest('div');
                            }
                            novels.push({ providerId: match[1], novelId: match[2], id, container });
                            seen.add(id);
                        }
                    }
                } catch (e) { }
            });

            if (novels.length === 0) {
                NotificationUtils.showWarning('未在当前页面找到小说条目');
                return;
            }

            if (!confirm(`确定要为当前页面的 ${novels.length} 本小说${isAppend ? '追加' : '填充'}术语表吗？\n(包含 ${Object.keys(newGlossary).length} 个术语)`)) {
                return;
            }

            // Clear previous status badges if any
            if (visualFeedback) {
                document.querySelectorAll('.ntr-glossary-badge').forEach(el => el.remove());
            }

            let successCount = 0;
            let failCount = 0;

            const setNovelStatus = (container, status, message) => {
                if (!visualFeedback || !container) return;
                let badge = container.querySelector('.ntr-glossary-badge');
                if (!badge) {
                    badge = document.createElement('span');
                    badge.className = 'ntr-glossary-badge';
                    // Insert at a visible position: try to append to the first n-flex or the container itself
                    const flex = container.querySelector('n-flex') || container.querySelector('.n-flex') || container;
                    if (flex.firstElementChild) {
                        flex.insertBefore(badge, flex.firstElementChild);
                    } else {
                        flex.appendChild(badge);
                    }
                }
                badge.className = 'ntr-glossary-badge ntr-glossary-' + status;
                badge.title = message;
                const iconMap = { success: '✅', fail: '❌', pending: '⏳' };
                badge.textContent = iconMap[status] || '⏳';
            };

            for (const novel of novels) {
                if (visualFeedback && novel.container) {
                    setNovelStatus(novel.container, 'pending', '正在填充术语表...');
                }
                try {
                    let finalGlossary = newGlossary;
                    
                    if (isAppend) {
                        const getRes = await script.fetch(`${window.location.origin}/api/novel/${novel.providerId}/${novel.novelId}`);
                        if (getRes.ok) {
                            const data = await getRes.json();
                            finalGlossary = Object.assign({}, data.glossary || {}, newGlossary);
                        } else {
                            throw new Error('Fetch failed');
                        }
                    }

                    const putRes = await script.fetch(`${window.location.origin}/api/novel/${novel.providerId}/${novel.novelId}/glossary`, true, {
                        method: 'PUT',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(finalGlossary)
                    });

                    if (putRes.ok) {
                        successCount++;
                        setNovelStatus(novel.container, 'success', `术语表填充成功 (+${Object.keys(newGlossary).length} 术语)`);
                    } else {
                        failCount++;
                        setNovelStatus(novel.container, 'fail', `术语表填充失败: HTTP ${putRes.status}`);
                    }
                } catch (e) {
                    console.error(`Failed to update glossary for ${novel.id}:`, e);
                    failCount++;
                    setNovelStatus(novel.container, 'fail', `术语表填充失败: ${e.message || '网络错误'}`);
                }
            }

            if (failCount === 0) {
                NotificationUtils.showSuccess(`成功填充 ${successCount} 本小说的术语表`);
            } else {
                NotificationUtils.showWarning(`填充完成: ${successCount} 成功, ${failCount} 失败`);
            }
        }
    };

    // -----------------------------------
    // AI 术语表 modules
    // -----------------------------------

    // 公共：解析 LLM workers（优先“臨時端點”，否则取工作区 GPT 翻譯器）
    const resolveGlossaryWorkers = async (cfg) => {
        const testEndpoint = (getModuleSetting(cfg, '臨時端點') || '').trim();
        if (testEndpoint) {
            return [{
                id: '臨時端點',
                model: (getModuleSetting(cfg, '臨時模型') || 'mock-glossary-1').trim(),
                endpoint: testEndpoint,
                key: (getModuleSetting(cfg, '臨時Key') || 'no_key_required').trim(),
            }];
        }
        const data = await StorageUtils._getData(StorageUtils.gpt);
        const wanted = (getModuleSetting(cfg, '翻譯器') || '').trim();
        const workers = data.workers
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
            title: '選擇本地卷',
            options: volumes,
            renderOption: (v) => `${v.id}（${v.chapters} 章，術語 ${v.glossaryCount} 條）`,
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
            if (volumes.length === 0) throw new Error('該文庫小說沒有已上傳的日文卷');
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
        throw new Error('未知目標');
    };

    // 公共：跑一次提取（含进度浮窗）
    const runGlossaryExtraction = async (cfg, target) => {
        const workers = await resolveGlossaryWorkers(cfg);
        if (workers.length === 0) {
            NotificationUtils.showError('未找到 GPT 翻譯器（可在工作區添加，或填寫“臨時端點”）');
            return undefined;
        }
        const sourceLanguage = getModuleSetting(cfg, '原文語言') || 'JA';
        const maxLines = Number(getModuleSetting(cfg, '行數上限')) || 0;
        const timeoutMs = Math.max(5, Number(getModuleSetting(cfg, '逾時(秒)')) || 300) * 1000;
        const concurrency = Math.max(1, Number(getModuleSetting(cfg, '併發')) || 2);
        const maxRounds = Math.max(1, Number(getModuleSetting(cfg, '最大輪數')) || 3);
        const budgetChars = Math.max(200, Number(getModuleSetting(cfg, '分塊字數')) || 3000);
        const rpm = Math.max(0, Number(getModuleSetting(cfg, 'RPM')) || 0);

        let stopped = false;
        const progress = GlossaryUI.status(`AI提取術語表 - ${GlossaryTargets.describe(target)}`, { onStop: () => { stopped = true; } });
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
            progress.update(`準備提取：${lines.length} 行 / ${workers.length} 個翻譯器`);

            const requester = GlossaryEngine.createRequester(workers, { timeoutMs, rps: concurrency, rpm });
            const result = await GlossaryEngine.runJob({
                lines,
                callLLM: (messages) => requester.call(messages),
                options: { budgetChars, maxRounds, concurrency, targetLanguage: '中文' },
                shouldStop: () => stopped,
                onProgress: (p) => {
                    const ratio = p.totalChunks ? p.chunksDone / Math.max(1, p.totalChunks) : 0;
                    progress.update(`第 ${p.round}/${p.maxRounds} 輪 · 完成 ${p.chunksDone} 塊 / 失敗 ${p.chunksFailed} 塊 · 待處理 ${p.pendingLines} 行`, ratio);
                },
            });
            progress.close();

            const failedHint = result.pendingLines > 0 ? `（${result.pendingLines} 行未能提取）` : '';
            NotificationUtils.showSuccess(`提取完成：${result.glossary.length} 條術語${failedHint}`);

            const existing = await GlossaryTargets.loadGlossary(target);
            const mode = (getModuleSetting(cfg, '模式') || '預覽') === '寫入' ? 'merge' : 'preview';
            GlossaryUI.open({
                title: `AI提取術語表 - ${target.title || GlossaryTargets.describe(target)}（${result.glossary.length} 條）`,
                target,
                entries: result.glossary,
                existing,
                mode,
                onWrite: (picked) => writeGlossaryMerged(target, picked),
            });
            return result;
        } catch (e) {
            progress.close();
            NotificationUtils.showError(`提取失敗：${e.message || e}`);
            return undefined;
        }
    };

    // 公共：合并写入（快照 + 合并 + 保存）
    const writeGlossaryMerged = async (target, picked) => {
        const current = await GlossaryTargets.loadGlossary(target);
        await GlossaryTargets.takeSnapshot(target, current);
        const merged = Object.assign({}, current);
        picked.forEach((row) => { merged[row.src] = row.dst; });
        const res = await GlossaryTargets.saveGlossary(target, merged);
        if (res && res.refresh) {
            NotificationUtils.showWarning('本地卷術語表已更新：請刷新頁面後生效');
        }
        return { before: current, after: merged };
    };

    // 公共：解析术语表文本（JSON 或 jp => zh 行）
    const parseGlossaryText = (text) => {
        const trimmed = (text || '').trim();
        if (!trimmed) return {};
        if (trimmed.startsWith('{')) {
            try {
                const obj = JSON.parse(trimmed);
                const out = {};
                Object.keys(obj).forEach((k) => {
                    if (typeof obj[k] === 'string') out[k.trim()] = obj[k].trim();
                });
                return out;
            } catch (e) {
                NotificationUtils.showError(`JSON 解析失敗：${e.message}`);
                return {};
            }
        }
        const out = {};
        trimmed.split('\n').forEach((line) => {
            const idx = line.indexOf('=>');
            if (idx < 0) return;
            const src = line.slice(0, idx).trim();
            const dst = line.slice(idx + 2).trim();
            if (src && dst) out[src] = dst;
        });
        return out;
    };

    const moduleGlossaryExtract = {
        name: 'AI提取術語表',
        type: 'onclick',
        whitelist: ['/novel', '/wenku', '/bookshelf', '/workspace'],
        settings: [
            newStringSetting('翻譯器', ''),
            newStringSetting('臨時端點', ''),
            newStringSetting('臨時模型', 'mock-glossary-1'),
            newStringSetting('臨時Key', 'no_key_required'),
            newSelectSetting('原文語言', ['JA', 'KO', 'ZH'], 'JA'),
            newSelectSetting('模式', ['預覽', '寫入'], '預覽'),
            newNumberSetting('分塊字數', 3000),
            newNumberSetting('最大輪數', 3),
            newNumberSetting('併發', 2),
            newNumberSetting('RPM', 0),
            newNumberSetting('逾時(秒)', 300),
            newNumberSetting('行數上限', 0),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            const target = await resolveGlossaryTarget();
            if (!target) return;
            await runGlossaryExtraction(cfg, target);
        },
    };

    const moduleGlossaryImport = {
        name: '導入術語表(KWG)',
        type: 'onclick',
        whitelist: ['/novel', '/wenku', '/bookshelf', '/workspace'],
        settings: [
            newTextareaSetting('術語表', ''),
            newBooleanSetting('讀取剪貼板', false),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            let text = getModuleSetting(cfg, '術語表') || '';
            if (getModuleSetting(cfg, '讀取剪貼板')) {
                try {
                    // readText 在标签页不可见/无焦点时会永久挂起（既不返回也不 reject），必须超时兜底
                    const clip = await Promise.race([
                        navigator.clipboard.readText(),
                        new Promise((_, reject) => setTimeout(() => reject(new Error('clipboard timeout')), 3000)),
                    ]);
                    if (String(clip || '').trim() !== '') {
                        text = clip;
                    } else {
                        NotificationUtils.showWarning('剪貼板為空，改用設置里的術語表');
                    }
                } catch (e) { NotificationUtils.showWarning('讀取剪貼板失敗，改用設置里的術語表'); }
            }
            const imported = parseGlossaryText(text);
            const count = Object.keys(imported).length;
            if (count === 0) {
                NotificationUtils.showWarning('没有解析到術語（支持 JSON 或 原文 => 譯文 行）');
                return;
            }
            const target = await resolveGlossaryTarget();
            if (!target) return;
            const entries = Object.keys(imported).map((src) => ({ src, dst: imported[src], type: '', count: 0 }));
            const existing = await GlossaryTargets.loadGlossary(target);
            NotificationUtils.showSuccess(`已解析 ${count} 條術語`);
            GlossaryUI.open({
                title: `導入術語表 - ${target.title || GlossaryTargets.describe(target)}（${count} 條）`,
                target,
                entries,
                existing,
                mode: 'merge',
                onWrite: (picked) => writeGlossaryMerged(target, picked),
            });
        },
    };

    const moduleGlossaryRollback = {
        name: '回滾術語表',
        type: 'onclick',
        whitelist: ['/novel', '/wenku', '/bookshelf', '/workspace'],
        settings: [
            newBooleanSetting('確認', true),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            const target = await resolveGlossaryTarget();
            if (!target) return;
            const snap = await GlossaryTargets.getSnapshot(target);
            if (!snap) {
                NotificationUtils.showWarning('没有找到該目標的快照');
                return;
            }
            const timeHint = new Date(snap.createAt).toLocaleString();
            const countHint = Object.keys(snap.glossary || {}).length;
            if (getModuleSetting(cfg, '確認') && !confirm(`回滾 ${GlossaryTargets.describe(target)} 的術語表到快照（${timeHint}，${countHint} 條）？\n\n注意：術語表變更會使已翻譯章節標記為過期。`)) return;
            await GlossaryTargets.saveGlossary(target, snap.glossary);
            NotificationUtils.showSuccess(`已回滾到 ${timeHint} 的術語表（${countHint} 條）`);
        },
    };

    const moduleGlossaryQueue = {
        name: '術語隊列',
        type: 'onclick',
        whitelist: ['/novel', '/wenku', '/bookshelf', '/workspace', '/favorite'],
        settings: [
            newBooleanSetting('自動續跑', true),
            newBooleanSetting('自動確認純新增', false),
            newNumberSetting('保留已完成', 5),
            newNumberSetting('收藏添加上限', 30),
            newStringSetting('bind', 'none'),
        ],
        run: async function (cfg) {
            GlossaryQueue.openPanel();
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
        moduleGlossaryRollback,
        moduleGlossaryQueue,
        moduleSyncStorage,
    ];

    // -----------------------------------
    // Setting Utils
    // -----------------------------------
    class SettingUtils {
        static getTranslateMode(mode) {
            const map = { '常規': 'normal', '過期': 'expire', '重翻': 'all' };
            return map[mode];
        }
    }

    // -----------------------------------
    // TaskUtils Utils
    // -----------------------------------
    class TaskUtils {
        static getTypeString = (url) => {
            const patterns = {
                'wenkus': new RegExp(`^/wenku(\\?.*)?$`), // Matches /wenku and /wenku?params
                'wenku': new RegExp(`^/wenku\\/.*(\\?.*)?$`), // Matches /wenku/* and /wenku/*?params
                'novels': new RegExp(`^/novel(\\?.*)?$`), // Matches /novel and /novel?params
                'novel': new RegExp(`^/novel\\/.*(\\?.*)?$`), // Matches /novel/*/* and /novel/*/*?params
                'favorite-web': new RegExp(`^/favorite/web(/.*)?(\\?.*)?$`), // Matches /favorite/web and /favorite/web/* and /favorite/web?params
                'favorite-wenku': new RegExp(`^/favorite/wenku(/.*)?(\\?.*)?$`), // Matches /favorite/wenku and /favorite/wenku/* and /favorite/wenku?params
                'favorite-local': new RegExp(`^/favorite/local(/.*)?(\\?.*)?$`) // Matches /favorite/local and /favorite/local/* and /favorite/local?params
            };
            for (const [key, pattern] of Object.entries(patterns)) {
                if (pattern.test(url)) {
                    return key;
                }
            }
            return null;
        };

        static wenkuLinkBuilder(series, name, mode) {
            return `wenku/${series}/${name}?level=${mode}&forceMetadata=false&startIndex=0&endIndex=65536`
        }

        static webLinkBuilder(url, from = 0, to = 65536, mode) {
            return `web${url}?level=${mode}&forceMetadata=false&startIndex=${from}&endIndex=${to}`
        }

        //return "id"
        static wenkuIds() {
            const links = [...document.querySelectorAll('a[href^="/wenku/"]')];
            return links.map(link => link.getAttribute('href').split('/wenku/')[1]);
        }

        //return api link
        static webSearchApi(limit = 20) {
            const urlParams = new URLSearchParams(location.search);
            const page = Math.max(parseInt(urlParams.get('page')) - 1 || 0, 0);
            const query = urlParams.get('query') || '';
            const selected = urlParams.getAll('selected').map(Number);

            const typeMap = { '连载中': '1', '已完结': '2', '短篇': '3', '全部': '0' };
            const levelMap = { '一般向': '1', 'R18': '2', '全部': '0' };
            const translateMap = { 'GPT': '1', 'Sakura': '2', '全部': '0' };
            const sortMap = { '更新': '0', '点击': '1', '相关': '2' };

            // Map selected indices back to values if possible, or use default if URL is empty
            // On n.novelia.cc, selected[0] is provider, [1] is type, [2] is level, [3] is translate, [4] is sort
            const providerVal = selected[0] ?? 0xff; // 0xff is 'All'
            const typeVal = selected[1] ?? 0;
            const levelVal = selected[2] ?? 0;
            const translateVal = selected[3] ?? 0;
            const sortVal = selected[4] ?? 0;

            // Convert provider bitmask back to string
            const sourceMap = {
                'kakuyomu': 1,
                'syosetu': 2,
                'novelup': 4,
                'hameln': 8,
                'pixiv': 16,
                'alphapolis': 32
            };
            let providers = Object.keys(sourceMap)
                .filter(k => (providerVal & sourceMap[k]))
                .join(',');
            
            if (providerVal === 0xff || !providers) {
                providers = 'kakuyomu,syosetu,novelup,hameln,pixiv,alphapolis';
            }

            return `/api/novel?page=${page}&pageSize=${limit}&query=${encodeURIComponent(query)}` +
                `&provider=${encodeURIComponent(providers)}&type=${typeVal}&level=${levelVal}` +
                `&translate=${translateVal}&sort=${sortVal}`;
        }

        //return { task, description }
        static async assignTasksSmart(novels, smartJobLimit, smartChapterLimit, mode) {
            function undone(n) {
                if (mode === "normal") {
                    const sOrG = (n.sakura ?? n.gpt) || 0;
                    //Using max to deal with some total > sakura situation
                    return Math.max(n.total - sOrG, 0);
                }
                return n.total;
            }
            const totalChapters = novels.reduce((acc, n) => acc + undone(n), 0);
            const potentialMaxTask = Math.floor(totalChapters / smartChapterLimit);
            let maxTasks = Math.min(potentialMaxTask, smartJobLimit);

            if (maxTasks <= 0 && totalChapters > 0) {
                maxTasks = smartJobLimit;
            }
            if (totalChapters === 0) {
                return [];
            }
            const chunkSize = Math.ceil(totalChapters / (maxTasks || 1));
            const sorted = [...novels].sort((a, b) => undone(b) - undone(a));

            const result = [];
            let usedTasks = 0;

            for (const novel of sorted) {
                let remain = undone(novel);
                if (remain <= 0) continue;

                let startIndex = (mode === "normal") ? (novel.total - remain) : 0;

                while (remain > 0 && usedTasks < smartJobLimit) {
                    const thisChunk = Math.min(remain, chunkSize);
                    const endIndex = startIndex + thisChunk;

                    result.push({
                        task: TaskUtils.webLinkBuilder(novel.url, startIndex, endIndex, mode),
                        description: novel.description
                    });

                    usedTasks++;
                    remain -= thisChunk;
                    startIndex = endIndex;
                    if (usedTasks >= smartJobLimit) {
                        break;
                    }
                }
                if (usedTasks >= smartJobLimit) {
                    break;
                }
            }

            return result;
        }

        //return { task, description }
        static async assignTasksStatic(novels, parts, mode) {
            function undone(n) {
                if (mode === "normal") {
                    const sOrG = (n.sakura ?? n.gpt) || 0;
                    return n.total - sOrG;
                }
                return n.total;
            }

            const result = [];

            for (const novel of novels) {
                const totalChapters = undone(novel);
                if (totalChapters <= 0) continue;
                const startBase = (mode === "normal")
                    ? (novel.total - totalChapters)
                    : 0;

                const chunkSize = Math.ceil(totalChapters / parts);

                for (let i = 0; i < parts; i++) {
                    const chunkStart = startBase + i * chunkSize;
                    const chunkEnd = (i === parts - 1)
                        ? (startBase + totalChapters)
                        : (chunkStart + chunkSize);

                    if (chunkStart < startBase + totalChapters) {
                        result.push({
                            task: TaskUtils.webLinkBuilder(novel.url, chunkStart, chunkEnd, mode),
                            description: novel.description
                        });
                    }
                }
            }
            return result;
        }

        static async clickTaskMoveToTop(count, reserve=true) {
            const extras = document.querySelectorAll('.n-thing-header__extra');
            for (let i = 0; i < count;i++) {
                const offset = reserve ? extras.length - i - 1 : i;
                const container = extras[offset];
                const buttons = container.querySelectorAll('button');
                if (buttons.length) {
                    buttons[0].click();
                }
            }
        }

        static async clickButtons(name = '') {
            const btns = document.querySelectorAll('button');
            btns.forEach(btn => {
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

        const buildPrompt = ({ chunkText, targetLanguage = '中文' }) =>
            PROMPT_PREFIX.replace('{target_language}', targetLanguage) + '\n' + PROMPT_BASE + '\n' + PROMPT_SUFFIX + '\n文本片段：\n' + chunkText;

        const buildMessages = (opts) => [{ role: 'user', content: buildPrompt(opts) }];

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

        const checkEntry = (src, info) => {
            if (displayLength(src) > 32) return false;
            if (BLACKLIST_INFO.has((info || '').trim().toLowerCase())) return false;
            return true;
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
        const searchForContext = (glossary, lines) => {
            const pool = lines.slice();
            const ordered = glossary.slice().sort((a, b) => b.src.length - a.src.length);
            for (const entry of ordered) {
                const src = entry.src;
                const hits = new Set();
                pool.forEach((line, i) => { if (line.includes(src)) hits.add(i); });
                const contexts = [...new Set([...hits].map((i) => lines[i]))].sort((a, b) => b.length - a.length);
                entry.context = contexts;
                entry.count = contexts.length;
                hits.forEach((i) => { pool[i] = pool[i].split(src).join('#'.repeat(src.length)); });
            }
            return ordered.sort((a, b) => b.count - a.count);
        };

        // 汇总原始条目 -> 最终术语表（save_ouput 的过滤/投票/去重/计数）
        const postProcess = (entries, allLines) => {
            const group = {};
            for (const raw of entries) {
                let src = normalize(cleanRuby((raw.src || '').trim()));
                let dst = normalize(cleanRuby((raw.dst || '').trim()));
                const info = cleanRuby((raw.type || raw.info || '').trim());
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
            glossary = searchForContext(glossary, allLines);
            glossary = glossary.filter((v) => v.count > 0);
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
                    max_tokens: options.maxTokens || 8192,
                };

                // OpenAI O 系列 / api.openai.com：改用 max_completion_tokens
                if ((worker.endpoint || '').startsWith('https://api.openai.com') || RE_O_SERIES.test(model || '')) {
                    delete body.max_tokens;
                    body.max_completion_tokens = options.maxTokens || 8192;
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
                        return { ok: false, status: res.status, error: `HTTP ${res.status}`, retryAfterMs, workerId: worker.id };
                    }
                    const data = await res.json();
                    const message = (data.choices && data.choices[0] && data.choices[0].message) || {};
                    if (typeof message.reasoning_content === 'string' && message.reasoning_content !== '') {
                        const { result } = splitThink(message.content || '');
                        markOk(worker);
                        return { ok: true, content: result !== '' ? result : (message.content || ''), think: message.reasoning_content, workerId: worker.id };
                    }
                    markOk(worker);
                    return { ok: true, content: message.content || '', workerId: worker.id };
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
                pendingLines: pending.length, totalLines: lines.length, ...extra,
            });

            while (pending.length > 0 && round < maxRounds) {
                if (shouldStop && shouldStop()) break;
                const roundBudget = Math.max(200, Math.floor(budget / Math.pow(2, round)));
                const chunks = makeChunks(pending, roundBudget);
                const failedLines = [];
                let cursor = 0;

                report({ phase: 'round-start', totalChunks: chunks.length });

                const worker = async () => {
                    while (true) {
                        if (shouldStop && shouldStop()) return;
                        const myIndex = cursor;
                        cursor += 1;
                        if (myIndex >= chunks.length) return;
                        const chunk = chunks[myIndex];
                        const cacheKey = cache && cache.namespace ? `${cache.namespace}/r${round}/c${chunk.index}` : null;

                        // 命中缓存：直接复用该块结果（刷新/重开页面后续跑的核心）
                        if (cacheKey) {
                            const hit = await cache.get(cacheKey).catch(() => undefined);
                            if (hit && Array.isArray(hit.entries)) {
                                allEntries.push(...hit.entries);
                                processedLines.push(...chunk.lines);
                                chunksDone += 1;
                                report({ phase: 'chunk-cached', chunkIndex: chunk.index });
                                continue;
                            }
                        }

                        await limiter.wait();
                        if (!(await waitCooldown())) return;
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
                            if (cacheKey) await cache.put(cacheKey, { entries: parsed.entries, lines: chunk.lines, at: Date.now() }).catch(() => { });
                        } else {
                            failedLines.push(...chunk.lines);
                            chunksFailed += 1;
                            if (result && result.retryAfterMs) {
                                cooldownUntil = Math.max(cooldownUntil, Date.now() + result.retryAfterMs);
                                report({ phase: 'cooldown', waitMs: result.retryAfterMs });
                            }
                            const reason = result && result.ok ? '上游返回空内容' : ((result && result.error) || '未知错误');
                            console.warn('[GlossaryEngine] chunk failed:', reason, 'worker=', result && result.workerId);
                        }
                        report({ phase: 'chunk-done', chunkIndex: chunk.index });
                    }
                };

                await Promise.all(Array.from({ length: Math.min(concurrency, chunks.length) }, () => worker()));

                pending = failedLines;
                round += 1;
            }

            const glossary = postProcess(allEntries, processedLines);
            report({ phase: 'done' });
            return { glossary, chunksDone, chunksFailed, rounds: round, pendingLines: pending.length, processedLines };
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
            // 后处理
            postProcess, findBest, searchForContext,
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
            if (target.kind === 'web') return `網頁小說 ${target.providerId}/${target.novelId}`;
            if (target.kind === 'wenku') return `文庫小說 ${target.novelId}`;
            if (target.kind === 'local') return `本地卷 ${target.volumeId}`;
            return '未知目標';
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
            throw new Error('未知目標');
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
            throw new Error('未知目標');
        };

        // 快照（写入前的原术语表，用于回滚）
        const takeSnapshot = async (target, glossary) => {
            await GlossaryDB.put('snapshots', {
                id: targetKey(target),
                target,
                glossary,
                createAt: Date.now(),
            });
        };

        const getSnapshot = (target) => GlossaryDB.get('snapshots', targetKey(target));

        const rollback = async (target) => {
            const snap = await getSnapshot(target);
            if (!snap) throw new Error('没有可用的快照');
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

        return { targetKey, describe, loadGlossary, saveGlossary, takeSnapshot, getSnapshot, rollback, loadLocalVolumeText, listLocalVolumes };
    })();

    // -----------------------------------
    // Glossary UI (预览-合并-diff 弹层 + 进度浮窗)
    // -----------------------------------
    // ==GlossaryUI-START==
    const GlossaryUI = (() => {
        const CSS_ID = 'ntr-glossary-css';
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
.ntr-g-overlay .ntr-g-toolbar { padding: 8px 14px; border-bottom: 1px solid #2a2a2a; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12px; }
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
#ntr-glossary-status { position: fixed; right: 20px; top: 70px; z-index: 999998; background: #1E1E1E; color: #CCC; border: 1px solid #333; border-radius: 8px; padding: 10px 14px; font-family: Arial, "Microsoft YaHei", sans-serif; font-size: 12px; width: 320px; box-shadow: 0 4px 20px rgba(0,0,0,0.5); }
#ntr-glossary-status .ntr-gs-line { margin-bottom: 6px; }
#ntr-glossary-status .ntr-gs-bar { height: 6px; background: #333; border-radius: 3px; overflow: hidden; margin: 6px 0; }
#ntr-glossary-status .ntr-gs-bar > div { height: 100%; background: #4a8a4a; width: 0%; transition: width 0.2s; }
`;
            document.head.appendChild(style);
        };

        // 对比现有术语表，生成行与统计
        const computeDiff = (entries, existing) => {
            const rows = entries.map((entry) => {
                const has = Object.prototype.hasOwnProperty.call(existing, entry.src);
                let status = 'add';
                if (has && existing[entry.src] === entry.dst) status = 'same';
                else if (has) status = 'conflict';
                return { ...entry, existing: has ? existing[entry.src] : undefined, status };
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
        // options: { title, target, entries, existing, mode: 'preview'|'merge', onWrite(glossary, rows) }
        const open = ({ title, target, entries, existing, mode = 'preview', onWrite }) => {
            ensureStyles();
            const old = document.getElementById('ntr-glossary-overlay');
            if (old) old.remove();

            const { rows, stats } = computeDiff(entries, existing);
            const state = {
                filter: 'all',
                query: '',
                selected: new Set(),
                dsts: {},
                conflictPolicy: 'keep',   // keep = 保留现有；override = 采用新提取
            };
            // 默认勾选：新增且非截断
            rows.forEach((row, i) => {
                row._index = i;
                state.dsts[i] = row.dst;
                if (mode === 'merge' && row.status === 'add' && !row.partial) state.selected.add(i);
            });

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
            const tabDefs = [
                ['all', '全部'],
                ['add', '新增'],
                ['conflict', '衝突'],
                ['same', '相同'],
                ['existing', '僅已有'],
            ];
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
            const searchInput = document.createElement('input');
            searchInput.type = 'text';
            searchInput.placeholder = '搜索 src / dst…';
            searchInput.style.marginLeft = 'auto';
            searchInput.style.width = '220px';
            searchInput.oninput = () => { state.query = searchInput.value.trim(); render(); };
            toolbar.appendChild(searchInput);

            if (mode === 'merge') {
                const selectAdd = document.createElement('button');
                selectAdd.className = 'ntr-g-btn';
                selectAdd.textContent = '全選新增/衝突';
                selectAdd.onclick = () => { visibleRows().forEach((r) => { if (r.status === 'add' || r.status === 'conflict') state.selected.add(r._index); }); render(); };
                const selectNone = document.createElement('button');
                selectNone.className = 'ntr-g-btn';
                selectNone.textContent = '全不選';
                selectNone.onclick = () => { visibleRows().forEach((r) => state.selected.delete(r._index)); render(); };
                const conflictBtn = document.createElement('button');
                conflictBtn.className = 'ntr-g-btn';
                conflictBtn.textContent = '衝突：保留現有 ⇄ 採用新提取';
                conflictBtn.onclick = () => {
                    state.conflictPolicy = state.conflictPolicy === 'keep' ? 'override' : 'keep';
                    // 策略切换时同步勾选：採用新提取 -> 勾上全部衝突行；保留現有 -> 取消勾选
                    rows.forEach((row) => {
                        if (row.status !== 'conflict') return;
                        if (state.conflictPolicy === 'override') state.selected.add(row._index);
                        else state.selected.delete(row._index);
                    });
                    conflictBtn.textContent = state.conflictPolicy === 'keep' ? '衝突：保留現有 ⇄ 採用新提取' : '衝突：採用新提取 ⇄ 保留現有';
                    render();
                };
                toolbar.appendChild(selectAdd);
                toolbar.appendChild(selectNone);
                toolbar.appendChild(conflictBtn);
            }
            card.appendChild(toolbar);

            // 表格
            const body = document.createElement('div');
            body.className = 'ntr-g-body';
            const table = document.createElement('table');
            const thead = document.createElement('thead');
            thead.innerHTML = '<tr>'
                + (mode === 'merge' ? '<th style="width:34px"><input type="checkbox"></th>' : '')
                + '<th style="width:26%">原文</th><th style="width:22%">提取譯文</th>'
                + '<th style="width:60px">次數</th><th style="width:110px">類型</th>'
                + '<th style="width:22%">現有譯文</th><th style="width:90px">狀態</th></tr>';
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
            btnCopy.textContent = '複製 JSON';
            const btnDownload = document.createElement('button');
            btnDownload.className = 'ntr-g-btn';
            btnDownload.textContent = '下載 JSON';
            const btnClose = document.createElement('button');
            btnClose.className = 'ntr-g-btn';
            btnClose.textContent = '關閉';
            btnClose.onclick = () => overlay.remove();
            foot.appendChild(warn);
            foot.appendChild(btnCopy);
            foot.appendChild(btnDownload);
            if (mode === 'merge') {
                const btnWrite = document.createElement('button');
                btnWrite.className = 'ntr-g-btn primary';
                btnWrite.textContent = '合併寫入';
                btnWrite.onclick = async () => {
                    const picked = buildResultRows();
                    if (picked.length === 0) {
                        NotificationUtils.showWarning('沒有勾選任何條目');
                        return;
                    }
                    if (!confirm(`將寫入 ${picked.length} 條術語到：${GlossaryTargets.describe(target)}\n\n注意：術語表變更會使已翻譯章節標記為過期（需重翻）。\n確定寫入嗎？`)) return;
                    btnWrite.disabled = true;
                    try {
                        await onWrite(picked, rows);
                        NotificationUtils.showSuccess(`已寫入 ${picked.length} 條術語`);
                        overlay.remove();
                    } catch (e) {
                        NotificationUtils.showError(`寫入失敗：${e.message || e}`);
                        btnWrite.disabled = false;
                    }
                };
                foot.appendChild(btnWrite);
            }
            foot.appendChild(btnClose);
            card.appendChild(foot);

            const visibleRows = () => rows.filter((row) => {
                if (state.filter !== 'all' && row.status !== state.filter) return false;
                if (state.query) {
                    const q = state.query.toLowerCase();
                    if (!(row.src.toLowerCase().includes(q) || String(row.dst).toLowerCase().includes(q))) return false;
                }
                return true;
            });

            const buildResultRows = () => {
                const picked = [];
                rows.forEach((row) => {
                    if (row.status === 'existing') return;
                    if (row.status === 'same') return;
                    if (row.status === 'conflict' && state.conflictPolicy === 'keep') return;
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
                    const dst = (state.dsts[row._index] || '').trim();
                    if (dst !== '') g[row.src] = dst;
                });
                return g;
            };

            const render = () => {
                statsEl.textContent = `提取 ${stats.total} 條 | 新增 ${stats.add} | 衝突 ${stats.conflict} | 相同 ${stats.same} | 現有 ${stats.existing}`;
                tbody.innerHTML = '';
                const list = visibleRows();
                const limit = 800;
                list.slice(0, limit).forEach((row) => {
                    const tr = document.createElement('tr');
                    tr.className = 'status-' + row.status;
                    if (mode === 'merge') {
                        const td = document.createElement('td');
                        const cb = document.createElement('input');
                        cb.type = 'checkbox';
                        cb.checked = state.selected.has(row._index);
                        cb.onchange = () => {
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
                    } else {
                        tdDst.textContent = row.dst;
                    }
                    const tdCount = document.createElement('td');
                    tdCount.textContent = row.count;
                    const tdType = document.createElement('td');
                    tdType.textContent = row.type || '';
                    const tdExisting = document.createElement('td');
                    tdExisting.textContent = row.existing === undefined ? '—' : row.existing;
                    const tdStatus = document.createElement('td');
                    const badge = document.createElement('span');
                    const labelMap = { add: '新增', conflict: '衝突', same: '相同', existing: '僅已有' };
                    badge.className = 'ntr-g-badge ' + row.status;
                    badge.textContent = labelMap[row.status] || row.status;
                    tdStatus.appendChild(badge);
                    if (row.partial) {
                        const pb = document.createElement('span');
                        pb.className = 'ntr-g-badge partial';
                        pb.textContent = '截斷';
                        pb.style.marginLeft = '4px';
                        tdStatus.appendChild(pb);
                    }
                    tr.appendChild(tdSrc);
                    tr.appendChild(tdDst);
                    tr.appendChild(tdCount);
                    tr.appendChild(tdType);
                    tr.appendChild(tdExisting);
                    tr.appendChild(tdStatus);
                    tbody.appendChild(tr);
                });
                if (list.length > limit) {
                    const tr = document.createElement('tr');
                    const td = document.createElement('td');
                    td.colSpan = 7;
                    td.textContent = `另有 ${list.length - limit} 條未顯示（請用搜索/篩選縮小範圍）`;
                    td.style.color = '#888';
                    tr.appendChild(td);
                    tbody.appendChild(tr);
                }
                if (mode === 'merge') {
                    const picked = buildResultRows();
                    const willExpire = stats.add + stats.conflict;
                    warn.innerHTML = `寫入預估：${picked.length} 條；術語表變更後，已翻譯章節將被標記為過期（涉及新增/衝突 ${willExpire} 條）。`;
                } else {
                    warn.textContent = '預覽模式：不會寫入任何數據（合併寫入將在後續版本啟用）。';
                }
                if (mode === 'merge') {
                    const headCb = thead.querySelector('input[type=checkbox]');
                    if (headCb) {
                        headCb.onchange = () => {
                            visibleRows().forEach((r) => {
                                if (headCb.checked) state.selected.add(r._index);
                                else state.selected.delete(r._index);
                            });
                            render();
                        };
                    }
                }
            };

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
                btn.textContent = '選擇';
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

        return { open, status, pick, computeDiff, fmtText, fmtJson, copyText, downloadText };
    })();
    // ==GlossaryUI-END==

    // -----------------------------------
    // Glossary Queue (持久化任务队列：IDB jobs + chunks 分块缓存，刷新后可续跑)
    // -----------------------------------
    const GlossaryQueue = (() => {
        let scriptRef = null;
        let loopActive = false;
        let stopRequested = false;
        let runningJobId = null;
        let panelRefresh = null;

        const notify = () => { if (panelRefresh) { try { panelRefresh(); } catch (e) { } } };

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

        // 提取参数（复用“AI提取術語表”模块的设置；入队时快照进 job.options）
        const extractSettings = () => {
            const o = readSettings('AI提取術語表', {
                '原文語言': 'JA',
                '分塊字數': 3000,
                '最大輪數': 3,
                '併發': 2,
                'RPM': 0,
                '逾時(秒)': 300,
                '行數上限': 0,
                '翻譯器': '',
                '臨時端點': '',
                '臨時模型': 'mock-glossary-1',
                '臨時Key': 'no_key_required',
            });
            return {
                sourceLanguage: o['原文語言'],
                budgetChars: Math.max(200, Number(o['分塊字數']) || 3000),
                maxRounds: Math.max(1, Number(o['最大輪數']) || 3),
                concurrency: Math.max(1, Number(o['併發']) || 2),
                rpm: Math.max(0, Number(o['RPM']) || 0),
                timeoutMs: Math.max(5, Number(o['逾時(秒)']) || 300) * 1000,
                maxLines: Number(o['行數上限']) || 0,
                workerId: o['翻譯器'] || '',
                testEndpoint: o['臨時端點'] || '',
                testModel: o['臨時模型'] || 'mock-glossary-1',
                testKey: o['臨時Key'] || 'no_key_required',
            };
        };

        const queueSettings = () => readSettings('術語隊列', {
            '自動續跑': true,
            '自動確認純新增': false,
            '保留已完成': 5,
            '收藏添加上限': 30,
        });

        const resolveWorkers = async (options) => {
            if (options.testEndpoint) {
                return [{ id: '臨時端點', model: options.testModel, endpoint: options.testEndpoint, key: options.testKey }];
            }
            const data = await StorageUtils._getData(StorageUtils.gpt);
            return data.workers
                .filter((w) => !options.workerId || w.id === options.workerId)
                .filter((w) => w.endpoint && w.model)
                .map((w) => ({ id: w.id, model: w.model, endpoint: w.endpoint, key: w.key }));
        };

        // ---------- 任务 CRUD ----------
        const list = async () => (await GlossaryDB.getAll('jobs')).sort((a, b) => a.createAt - b.createAt);
        const get = (id) => GlossaryDB.get('jobs', id);
        const put = (job) => { job.updateAt = Date.now(); return GlossaryDB.put('jobs', job); };

        const purgeChunks = async (jobId) => {
            const chunks = await GlossaryDB.getAll('chunks');
            const prefix = 'job:' + jobId;
            for (const c of chunks) {
                if (String(c.id).startsWith(prefix)) await GlossaryDB.delete('chunks', c.id);
            }
        };

        const remove = async (id) => {
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
            try {
                job.state = 'running';
                job.error = null;
                await put(job); notify();

                const options = job.options || extractSettings();
                const workers = await resolveWorkers(options);
                if (workers.length === 0) throw new Error('没有可用的翻譯器（工作區 GPT 或 臨時端點）');

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

                job.progress = { round: 0, maxRounds: options.maxRounds, chunksDone: 0, chunksFailed: 0, pendingLines: lines.length, totalLines: lines.length };
                await put(job); notify();

                const requester = GlossaryEngine.createRequester(workers, { timeoutMs: options.timeoutMs, rps: options.concurrency, rpm: options.rpm });
                let lastWrite = 0;
                const result = await GlossaryEngine.runJob({
                    lines,
                    callLLM: (messages) => requester.call(messages),
                    options: {
                        budgetChars: options.budgetChars,
                        maxRounds: options.maxRounds,
                        concurrency: options.concurrency,
                        targetLanguage: '中文',
                    },
                    shouldStop: () => stopRequested,
                    cache: {
                        namespace: 'job:' + job.id,
                        get: (key) => GlossaryDB.get('chunks', key),
                        put: (key, value) => GlossaryDB.put('chunks', { id: key, ...value }),
                    },
                    onProgress: (p) => {
                        job.progress = {
                            round: p.round, maxRounds: p.maxRounds, chunksDone: p.chunksDone,
                            chunksFailed: p.chunksFailed, pendingLines: p.pendingLines, totalLines: p.totalLines,
                        };
                        const now = Date.now();
                        if (now - lastWrite > 800 || p.phase === 'done') {
                            lastWrite = now;
                            put(job).then(notify).catch(() => { });
                        }
                    },
                });

                job.entries = result.glossary;
                job.resultCount = result.glossary.length;
                job.progress = { ...job.progress, pendingLines: result.pendingLines };

                if (stopRequested) {
                    job.state = 'pending';
                    job.error = '已停止（已提取的分块已缓存，可继续）';
                } else if (result.glossary.length === 0) {
                    job.state = 'failed';
                    job.error = result.pendingLines > 0 ? `${result.pendingLines} 行全部提取失败` : '没有提取到术语';
                } else {
                    job.error = result.pendingLines > 0 ? `${result.pendingLines} 行未能提取（已保留其余结果）` : null;
                    const qs = queueSettings();
                    let autoWritten = false;
                    if (qs['自動確認純新增']) {
                        const existing = await GlossaryTargets.loadGlossary(job.target);
                        const { stats } = GlossaryUI.computeDiff(result.glossary, existing);
                        if (stats.conflict === 0 && stats.same === 0 && stats.add > 0) {
                            const picked = result.glossary.filter((e) => !e.partial).map((e) => ({ src: e.src, dst: e.dst, type: e.type }));
                            if (picked.length > 0) {
                                await writeGlossaryMerged(job.target, picked);
                                autoWritten = true;
                            }
                        }
                    }
                    job.state = autoWritten ? 'done' : 'review';
                }
                await put(job); notify();
            } catch (e) {
                job.state = 'failed';
                job.error = String((e && e.message) || e);
                await put(job); notify();
            } finally {
                runningJobId = null;
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

        // 重试：保留分块缓存（只补失败块）
        const retry = async (id) => {
            const job = await get(id);
            if (!job) return;
            job.state = 'pending';
            job.error = null;
            await put(job);
            notify();
            runLoop();
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
                    if (qs['自動續跑'] && jobs.some((j) => j.state === 'pending')) {
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
            const target = await resolveGlossaryTarget();
            if (!target) return 0;
            const created = await addJobs([target], extractSettings());
            NotificationUtils.showSuccess(`已加入隊列：${GlossaryTargets.describe(target)}`);
            return created.length;
        };

        const addFavoriteWeb = async (limit) => {
            if (!/^\/favorite\/web/.test(window.location.pathname)) {
                NotificationUtils.showWarning('請在收藏頁（/favorite/web）使用');
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
            await addJobs(targets, extractSettings());
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
            if (!confirm(`將 ${picked.length} 本本地卷加入隊列？`)) return 0;
            await addJobs(picked.map((v) => ({ kind: 'local', volumeId: v.id, title: v.id })), extractSettings());
            NotificationUtils.showSuccess(`已加入 ${picked.length} 本本地卷`);
            return picked.length;
        };

        // ---------- 队列面板 ----------
        const openPanel = () => {
            // 触发样式注入
            const warm = GlossaryUI.status('術語隊列');
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
            titleEl.textContent = '術語隊列';
            const statsEl = document.createElement('div');
            statsEl.className = 'ntr-g-stats';
            head.appendChild(titleEl);
            head.appendChild(statsEl);
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
            mkBtn('加入當前頁', () => addCurrentPage());
            mkBtn('加入收藏頁', () => addFavoriteWeb(Number(queueSettings()['收藏添加上限']) || 30));
            mkBtn('加入本地書架', () => addLocalVolumes());
            mkBtn('開始/續跑', () => runLoop());
            mkBtn('停止', () => stop());
            mkBtn('匯出備份', async () => {
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
                        NotificationUtils.showSuccess(`已匯入 ${added} 個任務`);
                        render();
                    } catch (e) {
                        NotificationUtils.showError(`匯入失敗：${e.message}`);
                    }
                };
                input.click();
            };
            mkBtn('匯入備份', () => importPanelFile());
            mkBtn('清理已完成', async () => {
                const n = await cleanup(queueSettings()['保留已完成']);
                NotificationUtils.showSuccess(`已清理 ${n} 個`);
            });
            mkBtn('重新整理', () => render());
            card.appendChild(toolbar);

            const body = document.createElement('div');
            body.className = 'ntr-g-body';
            const table = document.createElement('table');
            table.innerHTML = '<thead><tr><th style="width:24%">目標</th><th style="width:70px">狀態</th><th style="width:22%">進度</th><th style="width:60px">結果</th><th>備註</th><th style="width:200px">操作</th></tr></thead>';
            const tbody = document.createElement('tbody');
            table.appendChild(tbody);
            body.appendChild(table);
            card.appendChild(body);

            const foot = document.createElement('div');
            foot.className = 'ntr-g-foot';
            const hint = document.createElement('div');
            hint.className = 'ntr-g-warn';
            hint.textContent = '隊列串行執行；「待確認」的任務點“預覽”走 預覽-合併-diff 後再寫入。刷新/重開頁面會自動續跑。';
            const btnClose = document.createElement('button');
            btnClose.className = 'ntr-g-btn';
            btnClose.textContent = '關閉';
            btnClose.onclick = () => { overlay.remove(); panelRefresh = null; };
            foot.appendChild(hint);
            foot.appendChild(btnClose);
            card.appendChild(foot);

            const stateLabels = {
                pending: '待處理', running: '提取中', review: '待確認', done: '完成', failed: '失敗', stopped: '已停止',
            };

            const render = async () => {
                if (!document.body.contains(overlay)) { panelRefresh = null; return; }
                const jobs = await list();
                statsEl.textContent = `共 ${jobs.length} | 待處理 ${jobs.filter((j) => j.state === 'pending').length} | 提取中 ${jobs.filter((j) => j.state === 'running').length} | 待確認 ${jobs.filter((j) => j.state === 'review').length} | 完成 ${jobs.filter((j) => j.state === 'done').length} | 失敗 ${jobs.filter((j) => j.state === 'failed').length}`;
                tbody.innerHTML = '';
                jobs.forEach((job) => {
                    const tr = document.createElement('tr');
                    const tdTitle = document.createElement('td');
                    tdTitle.textContent = job.title || GlossaryTargets.describe(job.target);
                    tdTitle.title = GlossaryTargets.describe(job.target);
                    const tdState = document.createElement('td');
                    const badge = document.createElement('span');
                    badge.className = 'ntr-g-badge ' + (job.state === 'done' ? 'add' : (job.state === 'review' ? 'conflict' : (job.state === 'failed' ? 'partial' : 'same')));
                    badge.textContent = stateLabels[job.state] || job.state;
                    tdState.appendChild(badge);
                    const tdProg = document.createElement('td');
                    if (job.progress) {
                        const p = job.progress;
                        tdProg.textContent = p.sync
                            ? p.sync
                            : `第 ${p.round}/${p.maxRounds} 輪 · ${p.chunksDone} 完成 / ${p.chunksFailed} 失敗 · 待 ${p.pendingLines}`;
                    } else {
                        tdProg.textContent = '—';
                    }
                    const tdResult = document.createElement('td');
                    tdResult.textContent = job.resultCount || 0;
                    const tdNote = document.createElement('td');
                    tdNote.textContent = job.error || '';
                    tdNote.style.color = job.error ? '#E8A96A' : '#888';
                    const tdOps = document.createElement('td');
                    const mkOp = (label, fn) => {
                        const b = document.createElement('button');
                        b.className = 'ntr-g-btn';
                        b.textContent = label;
                        b.style.padding = '2px 8px';
                        b.style.marginRight = '4px';
                        b.onclick = () => Promise.resolve(fn()).catch((e) => NotificationUtils.showError(String(e)));
                        tdOps.appendChild(b);
                    };
                    if (job.state === 'review' && job.entries && job.entries.length > 0) {
                        mkOp('預覽', () => openReview(job));
                    }
                    const partial = job.progress && job.progress.pendingLines > 0;
                    if (job.state === 'failed' || job.state === 'pending' || job.state === 'stopped' || partial) {
                        mkOp('重試', () => retry(job.id));
                    }
                    mkOp('刪除', async () => {
                        if (!confirm(`刪除任務《${job.title}》？`)) return;
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
                    td.textContent = '隊列為空：用上面的按鈕加入小說/本地卷';
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
                title: `隊列預覽 - ${job.title}（${(job.entries || []).length} 條）`,
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
            });
        };

        return {
            init, list, get, put, remove, addJobs, retry, stop, runLoop, cleanup,
            exportBackup, importBackup, openPanel, openReview, executeJob,
            extractSettings, queueSettings, _state: () => ({ loopActive, stopRequested, runningJobId }),
        };
    })();

    // -----------------------------------
    // Storage Utils
    // -----------------------------------
    class StorageUtils {
        static sakura = location.hostname === 'n.novelia.cc' ? 'workspace-sakura' : 'sakura-workspace';
        static gpt = location.hostname === 'n.novelia.cc' ? 'workspace-gpt' : 'workspace-gpt';
        static updateUrl = [
            'workspace/sakura',
            'workspace/gpt'
        ];

        static async update() {
            const storageKey = (window.location.pathname.includes('workspace/sakura') ? this.sakura : (window.location.pathname.includes('workspace/gpt') ? this.gpt : null));
            if (!storageKey) return;

            const data = await this._getData(storageKey);
            await this._setData(storageKey, data);
        }

        static async _setData(key, data) {
            localStorage.setItem(key, JSON.stringify(data));
            window.dispatchEvent(new StorageEvent('storage', {
                key: key,
                newValue: JSON.stringify(data),
                url: window.location.href,
                storageArea: localStorage
            }));
        }

        static async _getData(key) {
            try {
                let raw = localStorage.getItem(key);
                if (raw) {
                    const data = JSON.parse(raw);
                    // 验证数据结构完整性
                    if (!data.workers) data.workers = [];
                    if (!data.jobs) data.jobs = [];
                    if (!data.uncompletedJobs) data.uncompletedJobs = [];
                    return data;
                }
            } catch (e) {
                console.error('Failed to parse localStorage data for key:', key, e);
                // 数据损坏时尝试修复或重置
                try {
                    localStorage.removeItem(key);
                } catch (removeError) {
                    console.error('Failed to remove corrupted data:', removeError);
                }
            }
            return { workers: [], jobs: [], uncompletedJobs: [] };
        }

        static async addSakuraWorker(id, endpoint, amount = null, prevSegLength = 500, segLength = 500) {
            const total = amount ?? -1;
            let data = await this._getData(this.sakura);

            function _dataInsert(id, endpoint, prevSegLength, segLength) {
                const worker = { id, endpoint, prevSegLength, segLength };
                const existingIndex = data.workers.findIndex(w => w.id === id);
                if (existingIndex !== -1) {
                    data.workers[existingIndex] = worker;
                } else {
                    data.workers.push(worker);
                }
            }
            if (total == -1) {
                _dataInsert(id, endpoint, prevSegLength, segLength);
            } else {
                for (let i = 1; i < total + 1; i++) {
                    _dataInsert(id + i, endpoint, prevSegLength, segLength);
                }
            }
            await this._setData(this.sakura, data);
        }

        static async addGPTWorker(id, model, endpoint, key, amount = null) {
            const total = amount ?? -1;
            let data = await this._getData(this.gpt);

            function _dataInsert(id, model, endpoint, key) {
                const worker = { id, type: 'api', model, endpoint, key };
                const existingIndex = data.workers.findIndex(w => w.id === id);
                if (existingIndex !== -1) {
                    data.workers[existingIndex] = worker;
                } else {
                    data.workers.push(worker);
                }
            }
            if (total == -1) {
                _dataInsert(id, model, endpoint, key);
            } else {
                for (let i = 1; i < total + 1; i++) {
                    _dataInsert(id + i, model, endpoint, key);
                }
            }
            await this._setData(this.gpt, data);
        }

        static async removeWorker(key, id) {
            let data = await this._getData(key);
            data.workers = data.workers.filter(w => w.id !== id);
            await this._setData(key, data);
        }

        static async removeAllWorkers(key, exclude = []) {
            let data = await this._getData(key);
            data.workers = data.workers.filter(w => exclude.includes(w.id));
            await this._setData(key, data);
        }

        static async addJob(key, task, description, createAt = Date.now()) {
            const job = { task, description, createAt };
            let data = await this._getData(key);
            data.jobs.push(job);
            await this._setData(key, data);
        }

        static async addJobs(key, jobs = [], createAt = Date.now()) {
            let data = await this._getData(key);
            const existingTasks = new Set(data.jobs.map(job => job.task));
            jobs.forEach(({ task, description }) => {
                if (!existingTasks.has(task)) {
                    const job = { task, description, createAt };
                    data.jobs.push(job);
                }
            });
            await this._setData(key, data);
        }

        static async getUncompletedJobs(key) {
            return (await this._getData(key)).uncompletedJobs;
        }
    }

    class NotificationUtils {
        static _initContainer() {
            if (!this._container) {
                this._container = document.createElement('div');
                this._container.className = 'ntr-notification-container';
                document.body.appendChild(this._container);
            }
        }

        static showSuccess(text) {
            this._show(text, '✅');
        }

        static showWarning(text) {
            this._show(text, '⚠️');
        }

        static showError(text) {
            this._show(text, '❌');
        }

        static _show(msg, icon) {
            this._initContainer();
            const box = document.createElement('div');
            box.className = 'ntr-notification-message';

            const iconSpan = document.createElement('span');
            iconSpan.className = 'ntr-icon';
            iconSpan.textContent = icon;

            const textNode = document.createTextNode(msg);

            box.appendChild(iconSpan);
            box.appendChild(textNode);
            this._container.appendChild(box);

            setTimeout(() => {
                box.classList.add('fade-out');
                setTimeout(() => box.remove(), 300);
            }, 1000);
        }
    }


    // -----------------------------------
    // Main Toolbox
    // -----------------------------------
    class NTRToolBox {
        constructor() {
            this.configuration = this.loadConfiguration();
            this.keepActiveSet = new Set();
            this.headerMap = new Map();
            this._pollTimer = null;
            this.token = this.initToken();

            this._lastKeepRun = 0;
            this._lastVisRun = 0;
            this._lastEndPoint = window.location.href;

            this.buildGUI();
            this.attachGlobalKeyBindings();
            this.loadKeepStateAndStart();
            this.scheduleNextPoll();
        }

        static cloneDefaultModules() {
            return defaultModules.map(m => ({
                ...m,
                settings: m.settings ? m.settings.map(s => ({ ...s })) : [],
                _lastRun: 0
            }));
        }

        static DragHandler = class {
            constructor(panel, title) {
                this.panel = panel;
                this.title = title;
                this.dragging = false;
                this.offsetX = 0;
                this.offsetY = 0;
                this.init();
            }

            init() {
                this.title.addEventListener('mousedown', (e) => {
                    if (e.button !== 0) return;
                    // Disable transitions while dragging
                    this.panel.style.transition = 'none';
                    this.dragging = true;
                    this.offsetX = e.clientX - this.panel.offsetLeft;
                    this.offsetY = e.clientY - this.panel.offsetTop;
                    e.preventDefault();
                });

                document.addEventListener('mousemove', (e) => {
                    if (!this.dragging) return;
                    const newLeft = e.clientX - this.offsetX;
                    const newTop = e.clientY - this.offsetY;
                    this.panel.style.left = newLeft + 'px';
                    this.panel.style.top = newTop + 'px';
                    this.clampPosition();
                });

                document.addEventListener('mouseup', () => {
                    if (!this.dragging) return;
                    this.dragging = false;
                    // Re-enable transitions
                    this.panel.style.transition = 'width 0.3s ease, height 0.3s ease, top 0.3s ease, left 0.3s ease';
                    const rect = this.panel.getBoundingClientRect();
                    let left = rect.left;
                    let top = rect.top;
                    left = Math.min(Math.max(left, 0), window.innerWidth - rect.width);
                    top = Math.min(Math.max(top, 0), window.innerHeight - rect.height);
                    this.panel.style.left = left + 'px';
                    this.panel.style.top = top + 'px';
                    localStorage.setItem('ntr-panel-position', JSON.stringify({
                        left: this.panel.style.left,
                        top: this.panel.style.top
                    }));
                });
                // Touch events for mobile
                this.title.addEventListener('touchstart', (e) => {
                    // Disable transitions while dragging
                    this.panel.style.transition = 'none';
                    this.dragging = true;
                    const touch = e.touches[0];
                    this.offsetX = touch.clientX - this.panel.offsetLeft;
                    this.offsetY = touch.clientY - this.panel.offsetTop;
                    e.preventDefault();
                }, { passive: false });

                document.addEventListener('touchmove', (e) => {
                    if (!this.dragging) return;
                    const touch = e.touches[0];
                    const newLeft = touch.clientX - this.offsetX;
                    const newTop = touch.clientY - this.offsetY;
                    this.panel.style.left = newLeft + 'px';
                    this.panel.style.top = newTop + 'px';
                    this.clampPosition();
                    e.preventDefault();
                }, { passive: false });

                document.addEventListener('touchend', (e) => {
                    if (!this.dragging) return;
                    this.dragging = false;
                    // Re-enable transitions
                    this.panel.style.transition = 'width 0.3s ease, height 0.3s ease, top 0.3s ease, left 0.3s ease';
                    const rect = this.panel.getBoundingClientRect();
                    let left = rect.left;
                    let top = rect.top;
                    left = Math.min(Math.max(left, 0), window.innerWidth - rect.width);
                    top = Math.min(Math.max(top, 0), window.innerHeight - rect.height);
                    this.panel.style.left = left + 'px';
                    this.panel.style.top = top + 'px';
                    localStorage.setItem('ntr-panel-position', JSON.stringify({
                        left: this.panel.style.left,
                        top: this.panel.style.top
                    }));
                }, { passive: false });
            }

            clampPosition() {
                const rect = this.panel.getBoundingClientRect();
                let left = parseFloat(this.panel.style.left) || 0;
                let top = parseFloat(this.panel.style.top) || 0;
                const maxLeft = window.innerWidth - rect.width;
                const maxTop = window.innerHeight - rect.height;
                if (left < 0) left = 0;
                if (top < 0) top = 0;
                if (left > maxLeft) left = maxLeft;
                if (top > maxTop) top = maxTop;
                this.panel.style.left = left + 'px';
                this.panel.style.top = top + 'px';
            }
        }

        initToken() {
            const auth = localStorage.getItem('auth');
            if (auth) {
                const parsedInfo = JSON.parse(auth);
                return parsedInfo.profile.token;
            }
            return null;
        }

        loadConfiguration() {
            let stored;
            try {
                stored = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY));
            } catch (e) { }
            if (!stored || stored.version !== CONFIG_VERSION) {
                const fresh = NTRToolBox.cloneDefaultModules();
                return { version: CONFIG_VERSION, modules: fresh };
            }
            const loaded = NTRToolBox.cloneDefaultModules();
            stored.modules.forEach(storedMod => {
                const defMod = loaded.find(m => m.name === storedMod.name);
                if (defMod) {
                    for (const k in storedMod) {
                        if (k === 'settings') continue;
                        if (
                            defMod.hasOwnProperty(k) &&
                            typeof defMod[k] === typeof storedMod[k] &&
                            storedMod[k] !== undefined
                        ) {
                            defMod[k] = storedMod[k];
                        }
                    }
                    // settings 按设置名逐项合并：保留默认里的新设置项（老配置升级不丢新功能），只覆盖同名设置的值
                    if (Array.isArray(storedMod.settings) && Array.isArray(defMod.settings)) {
                        storedMod.settings.forEach(storedSetting => {
                            const defSetting = defMod.settings.find(s => s.name === storedSetting.name);
                            if (defSetting) {
                                Object.assign(defSetting, storedSetting);
                            }
                        });
                    }
                }
            });
            if (loaded.length !== defaultModules.length) {
                const fresh = NTRToolBox.cloneDefaultModules();
                localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify({ version: CONFIG_VERSION, modules: fresh }));
                return { version: CONFIG_VERSION, modules: fresh };
            } else {
                const defNames = defaultModules.map(x => x.name).sort().join(',');
                const storedNames = loaded.map(x => x.name).sort().join(',');
                if (defNames !== storedNames) {
                    const fresh = NTRToolBox.cloneDefaultModules();
                    localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify({ version: CONFIG_VERSION, modules: fresh }));
                    return { version: CONFIG_VERSION, modules: fresh };
                }
            }
            // Reattach run
            loaded.forEach(m => {
                const found = defaultModules.find(d => d.name === m.name);
                if (found && typeof found.run === 'function') {
                    for (const p in found) {
                        if (!m.hasOwnProperty(p)) {
                            m[p] = found[p];
                        }
                    }
                    m.run = found.run;
                }
            });
            return { version: CONFIG_VERSION, modules: loaded };
        }

        saveConfiguration() {
            localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(this.configuration));
        }

        buildGUI() {
            this.panel = document.createElement('div');
            this.panel.id = 'ntr-panel';

            // restore from localStorage
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
            this.titleBar.innerHTML = 'NTR ToolBox ' + VERSION;

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
                ? '單擊執行 | ⚙️設定'
                : '左鍵執行/切換 | 右鍵設定';
            rightInfo.textContent = 'Author: TheNano(百合仙人)';
            this.infoBar.appendChild(leftInfo);
            this.infoBar.appendChild(rightInfo);
            this.panel.appendChild(this.infoBar);

            document.body.appendChild(this.panel);

            // set up drag
            this.dragHandler = new NTRToolBox.DragHandler(this.panel, this.titleBar);

            this.buildModules();

            setTimeout(() => {
                this.expandedWidth = this.panel.offsetWidth;
                this.expandedHeight = this.panel.offsetHeight;

                const wasMin = this.isMinimized;
                if (!wasMin) this.panel.classList.add('minimized');
                const h0 = this.panel.offsetHeight;
                if (!wasMin) this.panel.classList.remove('minimized');

                this.minimizedWidth = this.panel.offsetWidth;
                this.minimizedHeight = h0;
            }, 150);

            if (IS_MOBILE) {
                // On mobile, single tap toggles minimized state.
                this.titleBar.addEventListener('click', e => {
                    if (!this.dragHandler.dragging) {
                        e.preventDefault();
                        this.setMinimizedState(!this.isMinimized);
                    }
                });
            } else {
                this.titleBar.addEventListener('contextmenu', e => {
                    e.preventDefault();
                    this.setMinimizedState(!this.isMinimized);
                });
            }
        }

        buildModules() {
            this.panelBody.innerHTML = '';
            this.headerMap.clear();

            this.configuration.modules.forEach(mod => {
                const container = document.createElement('div');
                container.className = 'ntr-module-container';

                const header = document.createElement('div');
                header.className = 'ntr-module-header';

                const nameSpan = document.createElement('span');
                nameSpan.textContent = mod.name;
                header.appendChild(nameSpan);

                if (!IS_MOBILE) {
                    const iconSpan = document.createElement('span');
                    iconSpan.textContent = (mod.type === 'keep') ? '⇋' : '▶';
                    iconSpan.style.marginLeft = '8px';
                    header.appendChild(iconSpan);
                }

                const settingsDiv = document.createElement('div');
                settingsDiv.className = 'ntr-settings-container';
                settingsDiv.style.display = 'none';

                if (IS_MOBILE) {
                    const btn = document.createElement('button');
                    btn.textContent = '⚙️';
                    btn.style.color = 'white';
                    btn.style.float = 'right';
                    btn.onclick = e => {
                        e.stopPropagation();
                        const styleVal = window.getComputedStyle(settingsDiv).display;
                        settingsDiv.style.display = (styleVal === 'none' ? 'block' : 'none');
                    };
                    header.appendChild(btn);

                    header.onclick = e => {
                        if (e.target.classList.contains('ntr-bind-button') || e.target === btn) return;
                        const stored = this.configuration.modules.find(m => m.name === mod.name);
                        const cfg = stored || mod;
                        NotificationUtils.showSuccess(`运行模块: ${mod.name}`);
                        this.handleModuleClick(cfg, header);
                    };
                } else {
                    header.oncontextmenu = e => {
                        e.preventDefault();
                        const styleVal = window.getComputedStyle(settingsDiv).display;
                        settingsDiv.style.display = (styleVal === 'none' ? 'block' : 'none');
                    };
                    header.onclick = e => {
                        if (e.button === 0 && !e.ctrlKey && !e.altKey && !e.shiftKey) {
                            if (e.target.classList.contains('ntr-bind-button')) return;
                            this.handleModuleClick(mod, header);
                        }
                    };
                }
                if (Array.isArray(mod.settings)) {
                    mod.settings.forEach(s => {
                        const row = document.createElement('div');
                        row.style.marginBottom = '8px';

                        const label = document.createElement('label');
                        label.style.display = 'inline-block';
                        label.style.minWidth = '70px';
                        label.style.color = '#ccc';
                        label.textContent = s.name + ': ';
                        row.appendChild(label);

                        let inputEl;
                        switch (s.type) {
                            case 'boolean': {
                                inputEl = document.createElement('input');
                                inputEl.type = 'checkbox';
                                inputEl.checked = !!s.value;
                                inputEl.onchange = () => {
                                    s.value = inputEl.checked;
                                    this.saveConfiguration();
                                };
                                break;
                            }
                            case 'number': {
                                inputEl = document.createElement('input');
                                inputEl.type = 'number';
                                inputEl.value = s.value;
                                inputEl.className = 'ntr-number-input';
                                inputEl.onchange = () => {
                                    s.value = Number(inputEl.value) || 0;
                                    this.saveConfiguration();
                                };
                                break;
                            }
                            case 'select': {
                                inputEl = document.createElement('select');
                                if (Array.isArray(s.options)) {
                                    s.options.forEach(opt => {
                                        const optEl = document.createElement('option');
                                        optEl.value = opt;
                                        optEl.textContent = opt;
                                        if (opt === s.value) optEl.selected = true;
                                        inputEl.appendChild(optEl);
                                    });
                                }
                                inputEl.onchange = () => {
                                    s.value = inputEl.value;
                                    this.saveConfiguration();
                                };
                                break;
                            }
                            case 'string': {
                                if (s.name === 'bind') {
                                    inputEl = document.createElement('button');
                                    inputEl.className = 'ntr-bind-button';
                                    inputEl.textContent = (s.value === 'none') ? '(None)' : `[${s.value.toUpperCase()}]`;
                                    inputEl.onclick = () => {
                                        inputEl.textContent = '(Press any key)';
                                        const handler = ev => {
                                            ev.preventDefault();
                                            if (ev.key === 'Escape') {
                                                s.value = 'none';
                                                inputEl.textContent = '(None)';
                                            } else {
                                                s.value = ev.key.toLowerCase();
                                                inputEl.textContent = `[${ev.key.toUpperCase()}]`;
                                            }
                                            this.saveConfiguration();
                                            document.removeEventListener('keydown', handler, true);
                                            ev.stopPropagation();
                                        };
                                        document.addEventListener('keydown', handler, true);
                                    };
                                } else {
                                    inputEl = document.createElement('input');
                                    inputEl.type = 'text';
                                    inputEl.value = s.value;
                                    inputEl.className = 'ntr-input';
                                    inputEl.onchange = () => {
                                        s.value = inputEl.value;
                                        this.saveConfiguration();
                                    };
                                }
                                break;
                            }
                            case 'textarea': {
                                inputEl = document.createElement('textarea');
                                inputEl.value = s.value;
                                inputEl.className = 'ntr-input';
                                inputEl.style.height = '80px';
                                inputEl.style.width = '180px';
                                inputEl.style.resize = 'vertical';
                                inputEl.onchange = () => {
                                    s.value = inputEl.value;
                                    this.saveConfiguration();
                                };
                                break;
                            }
                            default: {
                                inputEl = document.createElement('span');
                                inputEl.style.color = '#999';
                                inputEl.textContent = String(s.value);
                            }
                        }
                        row.appendChild(inputEl);
                        settingsDiv.appendChild(row);
                    });
                }

                container.appendChild(header);
                container.appendChild(settingsDiv);

                this.panelBody.appendChild(container);
                this.headerMap.set(mod, header);
            });
        }

        attachGlobalKeyBindings() {
            document.addEventListener('keydown', e => {
                if (e.ctrlKey || e.altKey || e.metaKey) return;
                const pk = e.key.toLowerCase();
                this.configuration.modules.forEach(mod => {
                    const bind = mod.settings.find(s => s.name === 'bind');
                    if (!bind || bind.value === 'none') return;
                    if (bind.value.toLowerCase() === pk) {
                        if (!isModuleEnabledByWhitelist(mod)) return;
                        e.preventDefault();
                        this.handleModuleClick(mod, null);
                    }
                });
            });
        }

        handleModuleClick(mod, header) {
            if (!domainAllowed || !isModuleEnabledByWhitelist(mod)) return;
            try {
                if (mod.type === 'onclick') {
                    if (typeof mod.run === 'function') {
                        Promise.resolve(mod.run(mod)).catch(console.error);
                    }
                } else if (mod.type === 'keep') {
                    const active = this.keepActiveSet.has(mod.name);
                    if (active) {
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
            const st = {};
            this.keepActiveSet.forEach(n => {
                st[n] = true;
            });
            localStorage.setItem('NTR_KeepState', JSON.stringify(st));
        }

        loadKeepStateAndStart() {
            let saved = {};
            try {
                saved = JSON.parse(localStorage.getItem('NTR_KeepState') || '{}');
            } catch (e) { }
            this.configuration.modules.forEach(mod => {
                if (mod.type === 'keep' && saved[mod.name]) {
                    const hdr = this.headerMap.get(mod);
                    if (hdr) {
                        this.startKeepModule(mod, hdr);
                    }
                }
            });
        }

        scheduleNextPoll() {
            const now = Date.now();
            if (now - this._lastKeepRun >= 100) {
                this.pollKeepModules();
                this._lastKeepRun = now;
            }
            if (now - this._lastVisRun >= 250) {
                this.updateModuleVisibility();
                if (this._lastEndPoint != window.location.href) {
                    StorageUtils.update();
                    this._lastEndPoint = window.location.href;
                }
                this._lastVisRun = now;
            }
            this._pollTimer = setTimeout(() => {
                this.scheduleNextPoll();
            }, 10);
        }

        pollKeepModules() {
            this.configuration.modules.forEach(mod => {
                if (mod.type === 'keep' && this.keepActiveSet.has(mod.name) && typeof mod.run === 'function') {
                    mod.run(mod);
                }
            });
        }

        runModule(name) {
            this.configuration.modules.filter(mod => mod.name == name).forEach(mod => {
                if (typeof mod.run === 'function') {
                    mod.run(mod, true);
                }
            });
        }

        updateModuleVisibility() {
            this.configuration.modules.forEach(mod => {
                const hdr = this.headerMap.get(mod);
                if (!hdr) return;
                const cont = hdr.parentElement;
                const allowed = domainAllowed && isModuleEnabledByWhitelist(mod) && !mod.hidden;
                if (!allowed) {
                    cont.style.display = 'none';
                    if (mod.type === 'keep' && this.keepActiveSet.has(mod.name)) {
                        this.stopKeepModule(mod, hdr);
                    }
                } else {
                    cont.style.display = 'block';
                }
            });
        }

        getAnchorCornerInfo(rect) {
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;
            const horizontal = (centerX < window.innerWidth / 2) ? 'left' : 'right';
            const vertical = (centerY < window.innerHeight / 2) ? 'top' : 'bottom';
            return {
                corner: vertical + '-' + horizontal,
                x: (horizontal === 'left' ? rect.left : rect.right),
                y: (vertical === 'top' ? rect.top : rect.bottom)
            };
        }

        setMinimizedState(newVal) {
            if (this.isMinimized === newVal) return;
            const rect = this.panel.getBoundingClientRect();
            const anchor = this.getAnchorCornerInfo(rect);

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

            setTimeout(() => {
                const newRect = this.panel.getBoundingClientRect();
                let left, top;
                switch (anchor.corner) {
                    case 'top-left':
                        left = anchor.x;
                        top = anchor.y;
                        break;
                    case 'top-right':
                        left = anchor.x - newRect.width;
                        top = anchor.y;
                        break;
                    case 'bottom-left':
                        left = anchor.x;
                        top = anchor.y - newRect.height;
                        break;
                    case 'bottom-right':
                        left = anchor.x - newRect.width;
                        top = anchor.y - newRect.height;
                        break;
                    default:
                        left = parseFloat(this.panel.style.left) || newRect.left;
                        top = parseFloat(this.panel.style.top) || newRect.top;
                }
                left = Math.min(Math.max(left, 0), window.innerWidth - newRect.width);
                top = Math.min(Math.max(top, 0), window.innerHeight - newRect.height);
                this.panel.style.left = left + 'px';
                this.panel.style.top = top + 'px';
                localStorage.setItem('ntr-panel-position', JSON.stringify({
                    left: this.panel.style.left,
                    top: this.panel.style.top
                }));
            }, 310);
        }

        async fetch(url, bypass = true, options = {}) {
            if (bypass && this.token) {
                const fetchOptions = {
                    method: options.method || 'GET',
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        ...(options.headers || {})
                    },
                    ...options
                };
                if (this.token && !fetchOptions.headers['Authorization']) {
                    fetchOptions.headers['Authorization'] = `Bearer ${this.token}`;
                }
                const response = await fetch(url, fetchOptions);
                return response;
            } else {
                return await fetch(url, options);
            }
        }

        delay(ms) {
            return new Promise(r => setTimeout(r, ms));
        }
    }

    const css = document.createElement('style');
    css.textContent = `
    #ntr-panel {
        position: fixed;
        left: 20px;
        top: 70px;
        z-index: 9999;
        background: #1E1E1E;
        color: #BBB;
        padding: 8px;
        border-radius: 8px;
        font-family: Arial, sans-serif;
        width: 320px;
        box-shadow: 2px 2px 12px rgba(0,0,0,0.5);
        border: 1px solid #333;
        transition: width 0.3s ease, height 0.3s ease, top 0.3s ease, left 0.3s ease;
    }
    #ntr-panel.minimized {
        width: 200px;
    }
    .ntr-titlebar {
        font-weight: bold;
        padding: 10px;
        cursor: move;
        background: #292929;
        border-radius: 6px;
        color: #CCC;
        user-select: none;
    }
    .ntr-panel-body {
        padding: 6px;
        background: #232323;
        border-radius: 4px;
        overflow-y: auto;
        max-height: 80vh;
        transition: max-height 0.3s ease;
    }
    #ntr-panel.minimized .ntr-panel-body {
        max-height: 0;
    }
    .ntr-module-container {
        margin-bottom: 12px;
        border: 1px solid #444;
        border-radius: 4px;
    }
    .ntr-module-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: #2E2E2E;
        padding: 6px 8px;
        border-radius: 3px 3px 0 0;
        border-bottom: 1px solid #333;
        cursor: pointer;
        transition: background 0.3s;
    }
    .ntr-module-header:hover {
        background: #3a3a3a;
    }
    .ntr-settings-container {
        padding: 6px;
        background: #1C1C1C;
        display: none;
    }
    .ntr-input {
        width: 120px;
        padding: 4px;
        border: 1px solid #555;
        border-radius: 4px;
        background: #2A2A2A;
        color: #FFF;
    }
    .ntr-number-input {
        width: 60px;
        padding: 4px;
        border: 1px solid #555;
        border-radius: 4px;
        background: #2A2A2A;
        color: #FFF;
    }
    .ntr-bind-button {
        padding: 4px 8px;
        border: 1px solid #555;
        border-radius: 4px;
        background: #2A2A2A;
        color: #FFF;
        cursor: pointer;
    }
    .ntr-info {
        display: flex;
        justify-content: space-between;
        font-size: 10px;
        color: #888;
        margin-top: 8px;
    }
    .ntr-module-header.active {
        background: #63E2B7 !important;
        color: #fff !important;
    }
    .ntr-notification-container {
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        z-index: 9999;
        display: flex;
        flex-direction: column;
        align-items: flex-start;
    }
    .ntr-notification-message {
        display: flex;
        align-items: center;
        min-width: 200px;
        margin-top: 8px;
        padding: 4px 8px;
        border-radius: 4px;
        background-color: #2A2A2A;
        color: #fff;
        font-size: 14px;
        font-family: sans-serif;
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
    /* Glossary Visual Feedback Badge Styles */
    .ntr-glossary-badge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        border-radius: 50%;
        font-size: 12px;
        margin-right: 6px;
        transition: all 0.3s ease;
        cursor: help;
        flex-shrink: 0;
    }
    .ntr-glossary-pending {
        background: linear-gradient(135deg, #fbbf24, #f59e0b);
        animation: ntr-pulse 1.5s infinite;
    }
    .ntr-glossary-success {
        background: linear-gradient(135deg, #4ade80, #22c55e);
        box-shadow: 0 0 8px rgba(34, 197, 94, 0.5);
    }
    .ntr-glossary-fail {
        background: linear-gradient(135deg, #ef4444, #dc2626);
        box-shadow: 0 0 8px rgba(220, 38, 38, 0.5);
    }
    @keyframes ntr-pulse {
        0%, 100% { transform: scale(1); opacity: 1; }
        50% { transform: scale(0.9); opacity: 0.7; }
    }
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
    // 调试句柄（控制台/自动化测试用，不影响正常逻辑）
    window._NTRToolBox = script;
    window._NTRGlossaryDev = {
        GlossaryEngine,
        GlossaryUI,
        GlossaryTargets,
        GlossaryDB,
        GlossaryQueue,
        resolveGlossaryWorkers,
        resolveGlossaryTarget,
        loadGlossarySourceText,
        runGlossaryExtraction,
        writeGlossaryMerged,
        parseGlossaryText,
    };
    // 队列自动续跑（含刷新后接管中断任务）
    GlossaryQueue.init(script);
})();
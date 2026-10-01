// 行为定格（重构前基线）：自动重试（keep 型，1s 节流轮询「未完成」条目并点「重试未完成任务」）
// 依赖站点 DOM（.n-list-item/.n-thing-main__description/.n-thing-header__extra + 按钮文案）——全部 stage 自建。
// 两个上游 quirk（tagName 小写永假、重启翻译器 false||3 短路）按现状钉住，重写须保持等价。
// 跑法：node tools/.run-suite.mjs tools/.e2e-auto-retry.js "http://127.0.0.1:8788/wenku/mock-src"
const out = { checks: [], notes: [], errors: [] };
const check = (label, cond, extra) => { out.checks.push({ label, ok: !!cond, extra: extra === undefined ? null : extra }); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const stage = document.createElement('div');
stage.id = 'ntr-e2e-autoretry-stage';
document.body.appendChild(stage);

let retryClicks = 0;
const retryBtn = document.createElement('button');
retryBtn.textContent = '重试未完成任务';
retryBtn.addEventListener('click', () => retryClicks++);
stage.appendChild(retryBtn);

let stopBtn = null;
const setStop = (on) => {
    if (stopBtn) { stopBtn.remove(); stopBtn = null; }
    if (on) {
        stopBtn = document.createElement('button');
        stopBtn.textContent = '停止';
        stage.appendChild(stopBtn);
    }
};

// 条目工厂：desc 含「未完成」即命中（includes 模糊匹配）；extra=true 时带 .n-thing-header__extra 置顶按钮
const topClicked = [];
const mkItem = (descText, withExtra) => {
    const item = document.createElement('div');
    item.className = 'n-list-item';
    const desc = document.createElement('div');
    desc.className = 'n-thing-main__description';
    desc.textContent = descText;
    item.appendChild(desc);
    if (withExtra) {
        const ex = document.createElement('div');
        ex.className = 'n-thing-header__extra';
        const b = document.createElement('button');
        b.textContent = '⇅';
        b.addEventListener('click', () => topClicked.push(b));
        ex.appendChild(b);
        item.appendChild(ex);
    }
    stage.appendChild(item);
    return item;
};

const box = window._NTRToolBox;
const mod = box.configuration.modules.find((m) => m.name === '自动重试');
// 保险：清掉可能残留的 keep 激活态（构造时 loadKeepStateAndStart 会按盘上 NTR_KeepState 自动启动 keep 模块，
// 主循环每 100ms 重跑激活的 keep 模块 —— 会与本套件的直调 run 竞争状态）
box.keepActiveSet.clear();
localStorage.removeItem('NTR_KeepState');
const setSetting = (name, value) => { const s = mod.settings.find((x) => x.name === name); if (s) s.value = value; };
const savedSettings = mod.settings.map((s) => ({ name: s.name, value: s.value }));
const forceTick = () => { mod._lastRun = 0; };   // 绕过 1s 节流，逐轮驱动

// 「启动翻译器」模块换成 spy（自动重试每轮 relaunch 都会按名直调它）
const launchMod = box.configuration.modules.find((m) => m.name === '启动翻译器');
const origLaunchRun = launchMod.run;
let launchCalls = 0;
launchMod.run = function () { launchCalls++; };

try {
    // ---------- A. 空页面：无条目 → 零动作（注意：这次 run 会占掉 1s 节流窗口） ----------
    await mod.run(mod);
    check('空页面：零重试点击、零重启', retryClicks === 0 && launchCalls === 0, { retryClicks, launchCalls });

    // ---------- B. 2 条未完成 + retry 按钮：点 min(2,3)=2 下 ----------
    const i1 = mkItem('翻译未完成（第 1 章）', true);
    const i2 = mkItem('任务未完成', true);
    mkItem('已完成，请勿命中', true);   // 对照条目：includes 匹配不应命中它
    forceTick();   // 绕过 A 轮占用的节流窗口
    await mod.run(mod);
    check('首轮：恰好点 2 下（未完成数，非条目总数）', retryClicks === 2, retryClicks);
    check('首轮：_attempts=1 且触发重启', mod._attempts === 1 && launchCalls === 1, { attempts: mod._attempts, launchCalls });

    // ---------- 节流：1s 内第二次 run 是 no-op ----------
    await mod.run(mod);
    check('节流：_interval 内第二次 run 不动作', retryClicks === 2 && launchCalls === 1 && mod._attempts === 1, { retryClicks, launchCalls });

    // ---------- C. 绕过节流再跑一轮 ----------
    forceTick();
    await mod.run(mod);
    check('下一轮：再点 2 下、_attempts=2', retryClicks === 4 && mod._attempts === 2, { retryClicks, attempts: mod._attempts });

    // ---------- D. 「停止」按钮存在：retry 抑制，但重启仍触发 ----------
    setStop(true);
    forceTick();
    await mod.run(mod);
    check('停止中：retry 零点击、_attempts 不增', retryClicks === 4 && mod._attempts === 2, { retryClicks, attempts: mod._attempts });
    check('停止中：重启翻译器仍被触发', launchCalls === 3, launchCalls);
    setStop(false);

    // ---------- E. retry 按钮不存在：_attempts 不增，重启仍触发 ----------
    retryBtn.remove();
    forceTick();
    await mod.run(mod);
    check('无 retry 按钮：_attempts 不增但重启触发', mod._attempts === 2 && launchCalls === 4, { attempts: mod._attempts, launchCalls });
    stage.insertBefore(retryBtn, stage.firstChild);

    // ---------- F. quirk1：真 button 点击不清零 _attempts（tagName==='button' 永假） ----------
    retryBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));   // retryBtn 自己的监听器把 retryClicks 计到 5
    check('quirk1：点击 button 后 _attempts 不归零', mod._attempts === 2, mod._attempts);

    // ---------- G. 重试上限 ----------
    setSetting('最大重试次数', 4);
    forceTick(); await mod.run(mod);   // attempts 2→3
    forceTick(); await mod.run(mod);   // attempts 3→4
    check('上限内：连跑到 _attempts=4', retryClicks === 9 && mod._attempts === 4, { retryClicks, attempts: mod._attempts });
    const launchBeforeCap = launchCalls;
    forceTick(); await mod.run(mod);   // attempts=4 >= 4 → 整个分支跳过
    check('达上限：零点击且不再重启', retryClicks === 9 && launchCalls === launchBeforeCap, { retryClicks, launchCalls });

    // ---------- H. quirk2：重启翻译器=false 仍触发（false||3 短路） ----------
    mod._attempts = 0;
    setSetting('重启翻译器', false);
    forceTick();
    await mod.run(mod);
    check('quirk2：关闭「重启翻译器」后仍触发启动', launchCalls === launchBeforeCap + 1 && retryClicks === 11, { launchCalls, before: launchBeforeCap, retryClicks });
    setSetting('重启翻译器', true);

    // ---------- I. 置顶重试任务：extras 从最后一个往前点 N 次 ----------
    setSetting('置顶重试任务', true);
    mod._attempts = 0;
    forceTick();
    await mod.run(mod);
    check('置顶：点 2 次（=未完成数）', topClicked.length === 2, topClicked.length);
    check('置顶：从最后一个 extra 往前', topClicked[0] === stage.querySelectorAll('.n-thing-header__extra button')[2]
        && topClicked[1] === stage.querySelectorAll('.n-thing-header__extra button')[1], topClicked.length);
    setSetting('置顶重试任务', false);
} catch (e) {
    out.errors.push('fatal: ' + (e && (e.stack || e.message || e)));
} finally {
    savedSettings.forEach(({ name, value }) => { const s = mod.settings.find((x) => x.name === name); if (s) s.value = value; });
    mod._attempts = 0;
    launchMod.run = origLaunchRun;
    box.keepActiveSet.clear();
    localStorage.removeItem('NTR_KeepState');
    stage.remove();
    out.notes.push('cleanup: 设置还原、启动翻译器 spy 还原、stage DOM 移除');
}
return JSON.stringify(out, null, 1);

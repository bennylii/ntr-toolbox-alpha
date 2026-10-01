// 极简 CDP 客户端（零依赖，node>=22 自带 WebSocket）
// 用法:
//   node tools/cdp.mjs open <url>          打开/复用标签页并导航，等待加载
//   node tools/cdp.mjs eval "<expr>"       在当前页执行表达式并打印结果
//   node tools/cdp.mjs evalf <file>        执行文件内容（async 函数体，可用 await）
//   node tools/cdp.mjs inject              注入 ntr-toolbox-alpha.user.js（去 UserScript 头）
//   node tools/cdp.mjs shot <out.png>      截图
//   node tools/cdp.mjs logs [n]            打印最近的 console/日志（默认 30 条）
//   node tools/cdp.mjs targets             列出页面目标
// 环境: CDP_PORT 默认 9333
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT = process.env.CDP_PORT || 9333;
const here = path.dirname(fileURLToPath(import.meta.url));

const httpJson = (url) => new Promise((resolve, reject) => {
  fetch(url).then((r) => r.json()).then(resolve).catch(reject);
});

const listTargets = async () => {
  const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  return list.filter((t) => t.type === 'page');
};

class Client {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.logs = [];
    this.dialogs = [];
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.consoleAPICalled') {
        const text = (msg.params.args || []).map((a) => a.value !== undefined ? a.value : (a.description || a.type)).join(' ');
        this.logs.push(`[console.${msg.params.type}] ${text}`);
      }
      if (msg.method === 'Log.entryAdded') {
        const e = msg.params.entry;
        this.logs.push(`[log.${e.level}] ${e.text}`);
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails;
        this.logs.push(`[exception] ${d.text} ${(d.exception && d.exception.description) || ''}`);
      }
      if (msg.method === 'Page.javascriptDialogOpening') {
        // 自动确认 confirm()/alert()，避免阻塞自动化
        this.dialogs.push({ type: msg.params.type, message: msg.params.message });
        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => { });
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error('CDP timeout: ' + method));
        }
      }, 300000);
    });
  }
}

const connect = async (target) => {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const client = new Client(ws);
  await client.send('Runtime.enable');
  await client.send('Page.enable');
  await client.send('Log.enable').catch(() => { });
  // 保持标签页前台，避免后台标签计时器被节流（影响 sleep 轮询）
  await client.send('Page.bringToFront').catch(() => { });
  return client;
};

const evalJs = async (client, expression, awaitPromise = true) => {
  const r = await client.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    const d = r.exceptionDetails;
    throw new Error('Eval error: ' + d.text + ' ' + ((d.exception && d.exception.description) || ''));
  }
  return r.result ? r.result.value : undefined;
};

const waitForLoad = async (client, timeoutMs = 30000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const state = await evalJs(client, 'document.readyState').catch(() => '');
    if (state === 'complete') return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
};

const main = async () => {
  const [cmd, arg] = process.argv.slice(2);
  const targets = await listTargets();
  let target = targets[0];
  if (!target) {
    // 打开 about:blank 兜底
    await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).catch(() => { });
    target = (await listTargets())[0];
  }
  if (!target) throw new Error('没有可用的页面目标（浏览器是否已用 --remote-debugging-port=' + PORT + ' 启动？）');
  const client = await connect(target);

  switch (cmd) {
    case 'targets': {
      targets.forEach((t) => console.log(t.id, t.url));
      break;
    }
    case 'open': {
      await client.send('Page.navigate', { url: arg });
      await waitForLoad(client, 45000);
      console.log('URL:', await evalJs(client, 'location.href'));
      break;
    }
    case 'eval': {
      const value = await evalJs(client, arg);
      console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      break;
    }
    case 'evalf': {
      const body = fs.readFileSync(arg, 'utf8');
      const value = await evalJs(client, `(async () => { ${body} })()`);
      console.log(typeof value === 'string' ? value : JSON.stringify(value, null, 2));
      break;
    }
    case 'inject': {
      const src = fs.readFileSync(path.join(here, '..', 'ntr-toolbox-alpha.user.js'), 'utf8')
        .replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==/, '');
      const expr = `(() => {
        try {
          window._NTRToolBoxInstance = false;
          document.querySelectorAll('#ntr-panel, #ntr-glossary-overlay, #ntr-glossary-status, #ntr-glossary-css, .ntr-notification-container').forEach((e) => e.remove());
          (new Function(${JSON.stringify(src)}))();
          return { ok: true, panel: !!document.getElementById('ntr-panel') };
        } catch (e) { return { ok: false, error: String(e) }; }
      })()`;
      const value = await evalJs(client, expr);
      console.log(JSON.stringify(value));
      break;
    }
    case 'shot': {
      const r = await client.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(arg, Buffer.from(r.data, 'base64'));
      console.log('saved', arg);
      break;
    }
    case 'cdp': {
      // cdp <Method> [jsonParams] —— 直通 CDP 命令（调试用）
      const params = process.argv[4] ? JSON.parse(process.argv[4]) : {};
      const r = await client.send(cmd === 'cdp' ? arg : cmd, params);
      console.log(JSON.stringify(r, null, 2));
      break;
    }
    case 'logs': {
      const n = Number(arg) || 30;
      console.log(client.logs.slice(-n).join('\n'));
      break;
    }
    case 'click': {
      // click <css选择器>  或  click text=<按钮文本>
      const expr = arg.startsWith('text=')
        ? `(() => {
            const want = ${JSON.stringify(arg.slice(5))};
            const els = [...document.querySelectorAll('button, .ntr-g-btn, .ntr-g-tab, .ntr-module-header, a, span, div')];
            const el = els.find((e) => e.textContent.trim() === want) || els.find((e) => e.textContent.includes(want));
            if (!el) return 'not-found';
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return 'clicked: ' + el.className;
          })()`
        : `(() => {
            const el = document.querySelector(${JSON.stringify(arg)});
            if (!el) return 'not-found';
            el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
            return 'clicked: ' + el.className;
          })()`;
      console.log(await evalJs(client, expr));
      break;
    }
    case 'dialogs': {
      console.log(JSON.stringify(client.dialogs.slice(-10), null, 2));
      break;
    }
    case 'watch': {
      // 保持连接并持续打印 console/异常，直到 Ctrl+C 或超时（秒）
      const secs = Number(arg) || 30;
      console.log('watching ' + secs + 's ...');
      let printed = 0;
      const timer = setInterval(() => {
        if (client.logs.length > printed) {
          console.log(client.logs.slice(printed).join('\n'));
          printed = client.logs.length;
        }
      }, 500);
      await new Promise((r) => setTimeout(r, secs * 1000));
      clearInterval(timer);
      if (client.logs.length > printed) console.log(client.logs.slice(printed).join('\n'));
      break;
    }
    default:
      console.log('未知命令，见文件头注释');
  }
  process.exit(0);
};

main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});

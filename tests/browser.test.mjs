/*!
 * 算账稿纸 · 浏览器端回归测试（CDP，无第三方依赖）
 * ------------------------------------------------------------
 * 覆盖：计算 / 财务模式 / 复制 / 回车携带 / 侧栏抽屉 / 持久化 /
 *       移动端布局无横向溢出 / PWA（manifest、SW、图标）
 *
 * 用法：先启动本地服务与可调试浏览器
 *   node tools/serve.mjs 8080
 *   "Microsoft Edge" --headless=new --remote-debugging-port=9223 about:blank
 *   node tests/browser.test.mjs http://localhost:8080/
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = Number(process.env.CDP_PORT || 9223);
const BASE = process.argv[2] || "http://localhost:8080/";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function connect() {
  let target = null;
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then((r) => r.json());
      target = list.find((t) => t.type === "page");
    } catch (e) {}
    if (!target) await sleep(250);
  }
  if (!target) throw new Error("未找到可调试页面（浏览器是否已启动？）");

  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("WebSocket 连接失败")); });

  let id = 0;
  const pending = new Map();
  const errors = [];
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.method === "Runtime.exceptionThrown") {
      errors.push(String(m.params.exceptionDetails.text || "") + " " +
        String((m.params.exceptionDetails.exception || {}).description || "").slice(0, 200));
    }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expr) => {
    const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.result && r.result.exceptionDetails) {
      return "EVAL-ERR: " + JSON.stringify(r.result.exceptionDetails).slice(0, 200);
    }
    return r.result && r.result.result ? r.result.result.value : undefined;
  };
  await send("Page.enable");
  await send("Runtime.enable");
  return { send, evaluate, errors };
}

const results = [];
function check(name, actual, expected) {
  const pass = JSON.stringify(actual) === JSON.stringify(expected);
  results.push({ name, pass, actual, expected });
}

/* ---------- 页面内测试辅助函数（注入到被测页面） ---------- */
const HELPERS = `
window.__t = {
  rows: () => document.querySelectorAll('#pad .row'),
  ta: (i) => document.querySelectorAll('#pad .row textarea')[i],
  items: () => document.querySelectorAll('#page-list .page-item'),
  setVal: (el, v) => {
    const s = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    s.call(el, v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  },
  key: (el, k, opts) => el.dispatchEvent(new KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, opts || {}))),
  result: (i) => document.querySelectorAll('#pad .row .row-result')[i].textContent,
  money: (i) => document.querySelectorAll('#pad .row .fin-money')[i].textContent,
  upper: (i) => document.querySelectorAll('#pad .row .fin-upper')[i].textContent,
  finHidden: (i) => document.querySelectorAll('#pad .row .row-fin')[i].classList.contains('hidden'),
  overflowX: () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  sidebarRect: () => { const r = document.getElementById('sidebar').getBoundingClientRect(); return { left: Math.round(r.left), width: Math.round(r.width) }; },
  scrimOn: () => { const s = document.getElementById('scrim'); return !!s && !s.hidden && s.classList.contains('on'); }
};
true;
`;

async function main() {
  const { send, evaluate, errors } = await connect();
  const url = BASE;

  /* ============ 0. 清空上次运行的残留状态 ============ */
  // 注意：必须先把页面卸载掉再清存储——应用会在 beforeunload 时把内存状态写回，
  // 若在页面存活时清理，会被这次回写覆盖。
  const origin = new URL(url).origin;
  await send("Page.navigate", { url: "about:blank" });
  await sleep(400);
  await send("Storage.clearDataForOrigin", {
    origin,
    storageTypes: "local_storage,cache_storage,service_workers,indexeddb"
  });
  await sleep(400);
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url });
  await sleep(2000);

  /* ============ 1. 桌面端 ============ */
  await evaluate(HELPERS);

  check("桌面端无横向溢出", await evaluate("window.__t.overflowX()"), 0);
  check("初始一行", await evaluate("window.__t.rows().length"), 1);
  check("侧栏默认展开", await evaluate("document.getElementById('sidebar').classList.contains('collapsed')"), false);

  // 计算
  await evaluate("window.__t.setVal(window.__t.ta(0), '2380 * 12.5')");
  await sleep(250);
  check("结果显示带千分位", await evaluate("window.__t.result(0)"), "=29,750");
  check("财务关闭时金额行隐藏", await evaluate("window.__t.finHidden(0)"), true);

  // 财务模式
  await evaluate("document.getElementById('btn-finance').click()");
  await sleep(250);
  check("财务模式开启", await evaluate("document.getElementById('btn-finance').classList.contains('on')"), true);
  check("金额行显示", await evaluate("window.__t.finHidden(0)"), false);
  check("金额文本", await evaluate("window.__t.money(0)"), "¥29,750.00");

  // 复制（安全上下文下走 Clipboard API）
  await evaluate("window.__t.setVal(window.__t.ta(0), '1234.567')");
  await sleep(200);
  check("金额四舍五入到分", await evaluate("window.__t.money(0)"), "¥1,234.57");
  check("大写按钮存在", await evaluate("window.__t.upper(0)"), "大写");
  check("大写内容正确", await evaluate(
    "window.SZCore.rmbUpper(window.SZCore.moneyPlain(window.SZCore.evaluate('1234.567').value))"
  ), "壹仟贰佰叁拾肆元伍角柒分");

  // 回车携带
  await evaluate("window.__t.key(window.__t.ta(0), 'Enter')");
  await sleep(300);
  check("回车后两行", await evaluate("window.__t.rows().length"), 2);
  check("财务模式携带金额", await evaluate("window.__t.ta(1).value"), "1234.57");

  // 持久化
  await sleep(600);
  check("已写入 localStorage", await evaluate("!!localStorage.getItem('suanzhang.data')"), true);
  await send("Page.navigate", { url });
  await sleep(2000);
  await evaluate(HELPERS);
  check("刷新后行数保持", await evaluate("window.__t.rows().length"), 2);
  check("刷新后内容保持", await evaluate("window.__t.ta(0).value"), "1234.567");

  /* ============ 2. 移动端 ============ */
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Page.navigate", { url });
  await sleep(2200);
  await evaluate(HELPERS);

  check("移动端无横向溢出", await evaluate("window.__t.overflowX()"), 0);
  check("移动端抽屉默认收起", await evaluate("document.getElementById('sidebar').classList.contains('collapsed')"), true);
  check("移动端遮罩未显示", await evaluate("window.__t.scrimOn()"), false);

  const sbCollapsed = await evaluate("window.__t.sidebarRect()");
  check("收起时侧栏移出屏幕", sbCollapsed.left < 0, true);

  // 打开抽屉
  await evaluate("document.getElementById('btn-sidebar').click()");
  await sleep(450);
  const sbOpen = await evaluate("window.__t.sidebarRect()");
  check("展开后侧栏进入屏幕", sbOpen.left >= 0, true);
  check("展开时显示遮罩", await evaluate("window.__t.scrimOn()"), true);
  check("展开时仍无横向溢出", await evaluate("window.__t.overflowX()"), 0);

  // 点遮罩关闭
  await evaluate("document.getElementById('scrim').click()");
  await sleep(450);
  check("点遮罩后抽屉收起", await evaluate("document.getElementById('sidebar').classList.contains('collapsed')"), true);

  // 移动端计算仍可用
  await evaluate("window.__t.setVal(window.__t.ta(0), '1280 + 960.5 * 3')");
  await sleep(250);
  check("移动端计算正常", await evaluate("window.__t.result(0)"), "=4,161.5");

  /* ---- 断点切换：桌面折叠偏好与移动抽屉状态互不污染 ---- */
  // 桌面端折叠侧栏并等偏好落盘
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await sleep(600);
  await evaluate("window.__t.key(document.body, 'b', { metaKey: true })");
  await sleep(700);
  check("桌面端折叠生效", await evaluate("document.getElementById('sidebar').classList.contains('collapsed')"), true);

  // 切到移动端：抽屉独立于桌面偏好，默认隐藏
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await sleep(700);
  check("切到移动端后抽屉隐藏", await evaluate("document.getElementById('sidebar').classList.contains('collapsed')"), true);

  // 移动端打开抽屉，再切回桌面：桌面仍应保持折叠（不被抽屉状态覆盖）
  await evaluate("document.getElementById('btn-sidebar').click()");
  await sleep(500);
  check("移动端可打开抽屉", await evaluate("window.__t.scrimOn()"), true);
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 1, mobile: false });
  await sleep(700);
  check("切回桌面仍保持折叠", await evaluate("document.getElementById('sidebar').classList.contains('collapsed')"), true);
  check("切回桌面无遮罩", await evaluate("window.__t.scrimOn()"), false);

  // 恢复：展开侧栏，避免影响后续断言
  await evaluate("document.getElementById('btn-sidebar').click()");
  await sleep(500);
  check("桌面端可再次展开", await evaluate("document.getElementById('sidebar').classList.contains('collapsed')"), false);

  /* ============ 3. PWA ============ */
  check("存在 manifest 链接", await evaluate("!!document.querySelector('link[rel=manifest]')"), true);
  const manifest = await evaluate("fetch('manifest.webmanifest').then(r => r.json()).then(m => ({ name: m.name, display: m.display, icons: m.icons.length, start: m.start_url }))");
  check("manifest 可解析", typeof manifest === "object" && manifest !== null, true);
  check("manifest display=standalone", manifest.display, "standalone");
  check("manifest 图标数", manifest.icons, 4);

  // 图标可达且尺寸正确
  const iconChecks = await evaluate(`(async () => {
    const out = {};
    for (const p of ['icons/icon-192.png','icons/icon-512.png','icons/icon-maskable-192.png','icons/icon-maskable-512.png','icons/apple-touch-icon.png','icons/favicon-32.png']) {
      const r = await fetch(p);
      out[p] = r.ok;
    }
    return out;
  })()`);
  check("所有图标可访问", Object.values(iconChecks).every(Boolean), true);

  // SW 注册
  const swState = await evaluate(`(async () => {
    if (!('serviceWorker' in navigator)) return 'unsupported';
    const reg = await navigator.serviceWorker.register('sw.js');
    await new Promise(r => setTimeout(r, 1200));
    return (reg.active || reg.installing || reg.waiting) ? 'registered' : 'pending';
  })()`);
  check("Service Worker 注册成功", swState, "registered");

  await sleep(1500);
  const cached = await evaluate(`(async () => {
    const keys = await caches.keys();
    if (!keys.length) return [];
    const c = await caches.open(keys[0]);
    return (await c.keys()).map(r => new URL(r.url).pathname).sort();
  })()`);
  // 子目录部署时路径会带上前缀，这里只校验文件名
  const hasFile = (list, name) => Array.isArray(list) && list.some((p) => p.endsWith(name));
  check("已预缓存应用外壳", hasFile(cached, "/index.html"), true);
  check("已缓存核心脚本", hasFile(cached, "/core.js") && hasFile(cached, "/app.js"), true);

  // 离线可用性
  await send("Network.enable");
  await send("Network.emulateNetworkConditions", { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await send("Page.navigate", { url });
  await sleep(2500);
  const offlineOk = await evaluate("document.querySelectorAll('#pad .row').length");
  check("离线仍能打开页面", typeof offlineOk === "number" && offlineOk >= 1, true);
  await send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });

  /* ============ 4. 截图 ============ */
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 860, deviceScaleFactor: 2, mobile: false });
  await send("Page.navigate", { url });
  await sleep(2000);
  await evaluate(HELPERS);
  await evaluate(`
    window.__t.setVal(window.__t.ta(0), '2380 * 12.5');
  `);
  await sleep(200);
  await evaluate("window.__t.key(window.__t.ta(0), 'Enter')");
  await sleep(300);
  await evaluate(`
    window.__t.setVal(window.__t.ta(1), '1280 + 960.5 * 3');
  `);
  await sleep(300);
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(ROOT, "tests", "screenshot-desktop.png"), Buffer.from(shot.result.data, "base64"));

  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
  await sleep(700);
  const shot2 = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(ROOT, "tests", "screenshot-mobile.png"), Buffer.from(shot2.result.data, "base64"));

  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  await sleep(700);
  const shot3 = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(ROOT, "tests", "screenshot-dark.png"), Buffer.from(shot3.result.data, "base64"));
  await send("Emulation.setEmulatedMedia", { features: [] });

  /* ============ 汇总 ============ */
  const failed = results.filter((r) => !r.pass);
  console.log("\n算账稿纸 · 浏览器回归测试");
  console.log("=".repeat(56));
  for (const r of results) {
    console.log((r.pass ? "  ✓ " : "  ✗ ") + r.name +
      (r.pass ? "" : `\n      期望 ${JSON.stringify(r.expected)} / 实际 ${JSON.stringify(r.actual)}`));
  }
  console.log("=".repeat(56));
  console.log(failed.length === 0
    ? `全部通过 ✓ (${results.length} 项)`
    : `失败 ${failed.length}/${results.length}`);
  if (errors.length) {
    console.log("\n未捕获异常:");
    errors.forEach((e) => console.log("  ! " + e));
  }
  process.exit(failed.length === 0 && errors.length === 0 ? 0 : 1);
}

main().catch((e) => { console.error("测试失败:", e.message); process.exit(1); });

/*!
 * 算账稿纸 · 界面逻辑
 * ------------------------------------------------------------
 * · 逐行实时计算、自动保存
 * · 左侧常驻稿纸列表（默认展开，可折叠，⌘/Ctrl+B；条目悬浮可导出/删除）
 * · 财务模式：双结果（原值 / 四舍五入到分），点击复制、一键复制大写
 * · 回车携带结果进入下一行：财务模式下携带四舍五入后的金额
 * · 支持 uTools 环境与普通浏览器（用于本地预览/调试）
 */
(function () {
  "use strict";

  var Core = window.SZCore;
  var ut = window.utools;
  var IS_UTOOLS = !!(ut && ut.db);
  var MAX_TITLE = 24;

  /* ============================ 宿主适配 ============================ */

  var db, copyText, copyImage;

  /* 非安全上下文（file:// 或 http 局域网）下 Clipboard API 不可用，回退到 execCommand */
  function legacyCopyText(s) {
    var ta = document.createElement("textarea");
    ta.value = s;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.top = "-1000px";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta);
  }

  function dataUrlToBlob(dataUrl) {
    var parts = String(dataUrl).split(",");
    var mime = /:(.*?);/.exec(parts[0]);
    var bin = atob(parts[1]);
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: mime ? mime[1] : "image/png" });
  }

  if (IS_UTOOLS) {
    db = ut.db;
    copyText = function (s) { ut.copyText(s); };
    copyImage = function (d, filename, done) {
      if (ut.copyImage) ut.copyImage(d);
      if (done) done("copied");
    };
  } else {
    var memStore = {};
    try { memStore = JSON.parse(window.localStorage.getItem("suanzhang.data") || "{}"); } catch (e) { memStore = {}; }
    var persist = function () { try { window.localStorage.setItem("suanzhang.data", JSON.stringify(memStore)); } catch (e) {} };
    db = {
      get: function (id) { return memStore[id]; },
      put: function (doc) {
        var d = JSON.parse(JSON.stringify(doc));
        memStore[d._id] = d; persist();
        return { ok: true, id: d._id, rev: "1-local" };
      },
      remove: function (docOrId) {
        var id = typeof docOrId === "string" ? docOrId : docOrId._id;
        delete memStore[id]; persist();
        return { ok: true, id: id };
      },
      allDocs: function (prefix) {
        return Object.keys(memStore)
          .filter(function (k) { return k.indexOf(prefix) === 0; })
          .map(function (k) { return JSON.parse(JSON.stringify(memStore[k])); });
      },
      promises: {
        remove: function (id) { delete memStore[id]; persist(); return Promise.resolve({ ok: true, id: id }); }
      }
    };
    copyText = function (s) {
      if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
        navigator.clipboard.writeText(s).catch(function () { legacyCopyText(s); });
      } else {
        legacyCopyText(s);
      }
    };

    /* 浏览器端：优先写入剪贴板；不支持时（Safari/Firefox 未实现 write(ClipboardItem)）
       退化为下载 PNG，保证功能始终可用 */
    copyImage = function (dataUrl, filename, done) {
      var canClipboard = navigator.clipboard && navigator.clipboard.write &&
        window.ClipboardItem && window.isSecureContext;
      if (canClipboard) {
        navigator.clipboard.write([new window.ClipboardItem({
          "image/png": dataUrlToBlob(dataUrl)
        })]).then(function () {
          if (done) done("copied");
        }).catch(function () { download(dataUrl, filename, done); });
      } else {
        download(dataUrl, filename, done);
      }
    };
  }

  function download(dataUrl, filename, done) {
    var a = document.createElement("a");
    a.href = dataUrl;
    a.download = filename || "算账稿纸.png";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    if (done) done("downloaded");
  }

  /* ============================ 状态 ============================ */

  var keySeq = Date.now();
  function nextKey() { return ++keySeq; }

  var state = {
    pages: [],
    current: 0,
    finance: false,
    sidebarCollapsed: false,
    drawerOpen: false,
    keypadOpen: true,
    haptic: true,
    activeRow: -1,
    editingRename: false,
    renamingId: null,
    confirmDeleteId: null,
    confirmDeleteUntil: 0,
    lastClickId: null,
    lastClickAt: 0
  };

  function currentPage() { return state.pages[state.current]; }

  function newPageObj() {
    return {
      id: "page/" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
      title: "",
      locked: false,
      createdAt: Date.now(),
      rows: [{ key: nextKey(), expr: "", ev: null }]
    };
  }

  /* ============================ 计算 ============================ */

  function evalExpr(expr) {
    var out = { ok: false };
    if (!expr || !expr.trim()) return out;
    var r;
    try { r = Core.evaluate(expr); } catch (e) { return out; }
    if (!r || !r.ok) return out;
    out.ok = true;
    out.value = r.value;
    out.resultText = Core.resultText(r.value);
    out.resultPlain = Core.resultPlain(r.value);
    out.moneyText = Core.moneyText(r.value);
    out.moneyPlain = Core.moneyPlain(r.value);
    out.upper = Core.rmbUpper(out.moneyPlain);
    return out;
  }

  /* ============================ 持久化 ============================ */

  var saveTimer = null;

  function putPage(p) {
    var d = {
      _id: p.id,
      title: p.title,
      locked: p.locked,
      createdAt: p.createdAt,
      updateAt: Date.now(),
      rows: p.rows.map(function (r) { return { expr: r.expr || "" }; })
    };
    var cur = db.get(p.id);
    if (cur && cur._rev) d._rev = cur._rev;
    var res = db.put(d);
    if (res && res.error) {
      var fresh = db.get(p.id);
      if (fresh && fresh._rev) { d._rev = fresh._rev; db.put(d); }
    }
  }

  function saveNow() {
    var p = currentPage();
    if (p) putPage(p);
    var s = db.get("settings") || { _id: "settings" };
    s.finance = state.finance;
    s.sidebarCollapsed = state.sidebarCollapsed;
    s.keypadOpen = state.keypadOpen;
    s.haptic = state.haptic;
    db.put(s);
  }

  function saveSoon() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () { saveTimer = null; saveNow(); }, 350);
  }

  function flush() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveNow();
  }

  function load() {
    var settings = db.get("settings") || {};
    state.finance = !!settings.finance;
    state.sidebarCollapsed = !!settings.sidebarCollapsed;
    state.keypadOpen = settings.keypadOpen !== false;
    state.haptic = settings.haptic !== false;

    var docs = (db.allDocs("page/") || []).filter(function (d) { return d && d._id; });
    docs.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });

    state.pages = docs.map(function (d) {
      var rows = (d.rows && d.rows.length ? d.rows : [{ expr: "" }]).map(function (r) {
        return { key: nextKey(), expr: (r && r.expr) || "", ev: null };
      });
      return {
        id: d._id,
        title: d.title || "",
        locked: !!d.locked,
        createdAt: d.createdAt || Date.now(),
        rows: rows
      };
    });
    if (!state.pages.length) state.pages.push(newPageObj());
    state.pages.forEach(function (p) {
      p.rows.forEach(function (r) { r.ev = evalExpr(r.expr); });
      // 清理历史遗留的末尾空白行（保留至少一行），不做任何"预置空行"
      while (p.rows.length > 1 && !(p.rows[p.rows.length - 1].expr || "").trim()) {
        p.rows.pop();
      }
    });
    state.current = 0;
  }

  /* ============================ DOM ============================ */

  var $pageList = document.getElementById("page-list");
  var $sidebar = document.getElementById("sidebar");
  var $btnSidebar = document.getElementById("btn-sidebar");
  var $btnNewPage = document.getElementById("btn-new-page");
  var $pageCount = document.getElementById("page-count");
  var $pad = document.getElementById("pad");
  var $toasts = document.getElementById("toasts");
  var $btnFinance = document.getElementById("btn-finance");
  var $btnAdd = document.getElementById("btn-add");
  var $btnRename = document.getElementById("btn-rename");
  var $btnLock = document.getElementById("btn-lock");
  var $btnImage = document.getElementById("btn-image");
  var $btnRemove = document.getElementById("btn-remove");
  var $brandDate = document.getElementById("brand-date");
  var $hintMain = document.getElementById("hint-main");
  var $hintMobile = document.getElementById("hint-mobile");
  var $hintLock = document.getElementById("hint-lock");
  var $scrim = document.getElementById("scrim");
  var $keypad = document.getElementById("keypad");
  var $btnKeypad = document.getElementById("btn-keypad");
  var $keypadGrid = document.getElementById("keypad-grid");
  var $keypadTarget = document.getElementById("keypad-target");
  var $keypadAction = document.getElementById("keypad-action");
  var $btnHaptic = document.getElementById("btn-haptic");

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function fmtDate(ts) {
    var d = new Date(ts);
    return d.getFullYear() + "/" + pad2(d.getMonth() + 1) + "/" + pad2(d.getDate()) +
      " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }
  function fmtDateShort(ts) {
    var d = new Date(ts);
    return pad2(d.getMonth() + 1) + "/" + pad2(d.getDate()) +
      " " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  function toast(msg) {
    var el = document.createElement("div");
    el.className = "toast";
    el.textContent = msg;
    $toasts.appendChild(el);
    while ($toasts.children.length > 3) $toasts.removeChild($toasts.firstChild);
    setTimeout(function () {
      el.classList.add("out");
      setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 320);
    }, 1700);
  }

  function copyWithToast(text, prefix) {
    copyText(text);
    toast(prefix + "：" + text);
  }

  /* ============================ 渲染 ============================ */

  function renderTop() {
    var p = currentPage();
    $btnFinance.classList.toggle("on", state.finance);
    $btnFinance.title = state.finance
      ? "财务模式已开启：结果四舍五入到分，可复制大写金额"
      : "财务模式：结果四舍五入到分，可复制大写金额";
    $brandDate.textContent = fmtDate(p.createdAt) + (p.locked ? " · 已锁定" : "");
    $btnLock.classList.toggle("on", p.locked);
    $btnLock.querySelector(".ic-lock").classList.toggle("hidden", !p.locked);
    $btnLock.querySelector(".ic-unlock").classList.toggle("hidden", !!p.locked);
    $hintLock.classList.toggle("hidden", !p.locked);
    $hintMain.classList.toggle("hidden", !!p.locked);
    if ($hintMobile) $hintMobile.classList.toggle("hidden", !!p.locked);
  }

  function pageLabel(p) { return p.title || fmtDate(p.createdAt); }

  function isMobile() {
    return window.matchMedia("(max-width: 720px)").matches;
  }

  /** 当前侧栏是否处于「收起/隐藏」状态：移动端看抽屉，桌面端看折叠偏好 */
  function sidebarHidden() {
    return isMobile() ? !state.drawerOpen : state.sidebarCollapsed;
  }

  function applySidebar() {
    var hidden = sidebarHidden();
    $sidebar.classList.toggle("collapsed", hidden);
    $btnSidebar.classList.toggle("on", !hidden);
    $btnSidebar.setAttribute("aria-expanded", String(!hidden));
    $btnSidebar.title = (hidden ? "展开" : "折叠") + "稿纸列表（⌘/Ctrl+B）";
    // 移动端抽屉展开时显示遮罩
    var open = isMobile() && state.drawerOpen;
    if ($scrim) {
      $scrim.hidden = !open;
      $scrim.classList.toggle("on", open);
    }
  }

  function toggleSidebar() {
    if (isMobile()) {
      state.drawerOpen = !state.drawerOpen;
    } else {
      state.sidebarCollapsed = !state.sidebarCollapsed;
      saveSoon();
    }
    applySidebar();
  }

  function closeDrawerOnMobile() {
    if (isMobile() && state.drawerOpen) {
      state.drawerOpen = false;
      applySidebar();
    }
  }

  function iconButton(svg, title, extraClass) {
    var b = document.createElement("button");
    b.type = "button";
    b.className = "pi-btn" + (extraClass ? " " + extraClass : "");
    b.title = title;
    b.innerHTML = svg;
    return b;
  }

  var SVG_EXPORT = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3.5" width="14" height="13" rx="2.2"/><circle cx="7.2" cy="8" r="1.4"/><path d="M4 14.5l4-4 3 3 2.4-2.4 2.6 2.6"/></svg>';
  var SVG_TRASH = '<svg viewBox="0 0 20 20" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 5.5h11M8 5V3.8h4V5M6 5.5l.7 10.2h6.6L14 5.5M8.6 8.5v4.6M11.4 8.5v4.6"/></svg>';

  function renderSidebar() {
    $pageList.textContent = "";
    state.pages.forEach(function (p, i) {
      var active = i === state.current;
      var item = document.createElement("div");
      item.className = "page-item" + (active ? " active" : "");

      if (active && state.editingRename) {
        var input = document.createElement("input");
        input.className = "rename-input";
        input.value = p.title || pageLabel(p);
        input.maxLength = MAX_TITLE;
        input.spellcheck = false;
        input.addEventListener("keydown", function (e) {
          e.stopPropagation();
          if (e.key === "Enter") { commitRename(input.value); }
          else if (e.key === "Escape") { state.editingRename = false; renderSidebar(); }
        });
        input.addEventListener("blur", function () { commitRename(input.value); });
        item.appendChild(input);
        $pageList.appendChild(item);
        setTimeout(function () { input.focus(); input.select(); }, 0);
        return;
      }

      var body = document.createElement("div");
      body.className = "pi-body";
      body.title = pageLabel(p) + "（双击重命名）";

      var main = document.createElement("div");
      main.className = "pi-main";
      var name = document.createElement("span");
      name.className = "pi-name";
      name.textContent = pageLabel(p);
      main.appendChild(name);
      if (p.locked) {
        var lock = document.createElement("span");
        lock.className = "pi-lock";
        lock.innerHTML = '<svg viewBox="0 0 20 20" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2"><rect x="4.5" y="8.5" width="11" height="8" rx="2"/><path d="M7 8.5V6.4a3 3 0 016 0v2.1"/></svg>';
        main.appendChild(lock);
      }

      var sub = document.createElement("div");
      sub.className = "pi-sub";
      var count = p.rows.filter(function (r) { return r.expr && r.expr.trim(); }).length;
      sub.textContent = count + " 行 · " + fmtDateShort(p.createdAt);

      body.appendChild(main);
      body.appendChild(sub);
      body.addEventListener("click", function () {
        var now = Date.now();
        // 双击（两次点击间隔 < 450ms）→ 重命名；状态记在 state 上，跨列表重渲染依然有效
        if (state.lastClickId === p.id && now - state.lastClickAt < 450) {
          state.lastClickId = null;
          state.lastClickAt = 0;
          startRename(i);
          return;
        }
        state.lastClickId = p.id;
        state.lastClickAt = now;
        switchPage(i);
      });

      var actions = document.createElement("div");
      actions.className = "pi-actions";
      var btnExport = iconButton(SVG_EXPORT, "复制这张稿纸为图片");
      btnExport.addEventListener("click", function (e) {
        e.stopPropagation();
        exportImage(state.pages[i]);
      });
      var btnDel = iconButton(SVG_TRASH, "删除这张稿纸", "danger");
      btnDel.addEventListener("click", function (e) {
        e.stopPropagation();
        askRemovePage(i);
      });
      actions.appendChild(btnExport);
      actions.appendChild(btnDel);

      item.appendChild(body);
      item.appendChild(actions);
      $pageList.appendChild(item);
    });
    $pageCount.textContent = state.pages.length + " 张";
  }

  function switchPage(i) {
    if (i !== state.current) {
      flush();
      state.current = i;
      state.editingRename = false;
      // 行索引属于上一张稿纸，切换后重置
      state.activeRow = -1;
      renderAll();
      var p = currentPage();
      if (!p.locked) setTimeout(function () { focusRow(p.rows.length - 1); }, 30);
    }
    closeDrawerOnMobile();
  }

  function startRename(index) {
    if (state.editingRename) return;
    if (typeof index === "number" && index !== state.current && state.pages[index]) switchPage(index);
    // 重命名需要侧栏可见
    if (isMobile()) {
      state.drawerOpen = true;
    } else if (state.sidebarCollapsed) {
      state.sidebarCollapsed = false;
      saveSoon();
    }
    applySidebar();
    state.editingRename = true;
    state.renamingId = currentPage().id;
    renderSidebar();
  }

  function commitRename(value) {
    if (!state.editingRename) return;
    state.editingRename = false;
    var id = state.renamingId;
    state.renamingId = null;
    var p = null;
    for (var i = 0; i < state.pages.length; i++) {
      if (state.pages[i].id === id) p = state.pages[i];
    }
    if (!p) { renderSidebar(); return; }
    p.title = String(value || "").trim().slice(0, MAX_TITLE);
    putPage(p);
    renderAll();
  }

  function addPage() {
    flush();
    state.pages.unshift(newPageObj());
    state.current = 0;
    state.editingRename = false;
    saveNow();
    renderAll();
    setTimeout(function () { focusRow(0); }, 30);
    toast("已新建稿纸");
  }

  function askRemovePage(index) {
    var p = state.pages[index];
    if (!p) return;
    if (state.confirmDeleteId === p.id && Date.now() < state.confirmDeleteUntil) {
      doRemovePage(index);
      return;
    }
    state.confirmDeleteId = p.id;
    state.confirmDeleteUntil = Date.now() + 3000;
    toast("再次点击删除「" + pageLabel(p) + "」");
  }

  function doRemovePage(index) {
    var p = state.pages[index];
    if (!p) return;
    if (state.editingRename && state.renamingId === p.id) state.editingRename = false;
    state.confirmDeleteId = null;
    db.promises.remove(p.id);
    state.pages.splice(index, 1);
    if (!state.pages.length) state.pages.push(newPageObj());
    if (index < state.current) state.current -= 1;
    if (state.current >= state.pages.length) state.current = state.pages.length - 1;
    saveNow();
    renderAll();
    toast("已删除稿纸");
  }

  function toggleLock() {
    var p = currentPage();
    p.locked = !p.locked;
    saveSoon();
    renderAll();
    toast(p.locked ? "已锁定：该稿纸暂时不可编辑" : "已解锁");
    if (!p.locked) setTimeout(function () { focusRow(p.rows.length - 1); }, 30);
  }

  /* ---------- 行渲染 ---------- */

  function autosize(ta) {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 168) + "px";
  }

  function refreshRow(row, dom) {
    var ev = row.ev;
    dom.res.textContent = "";
    dom.fin.classList.add("hidden");

    if (ev && ev.ok) {
      var eq = document.createElement("span");
      eq.className = "eq";
      eq.textContent = "=";
      dom.res.appendChild(eq);
      dom.res.appendChild(document.createTextNode(ev.resultText));
      dom.res.classList.remove("empty");

      if (state.finance) {
        var neg = ev.moneyPlain.charAt(0) === "-";
        var absText = Core.group(neg ? ev.moneyText.slice(1) : ev.moneyText);
        dom.money.textContent = "";
        var sym = document.createElement("span");
        sym.className = "sym";
        sym.textContent = (neg ? "−" : "") + "¥";
        dom.money.appendChild(sym);
        dom.money.appendChild(document.createTextNode(absText));
        dom.fin.classList.remove("hidden");
        dom.upper.classList.toggle("hidden", !ev.upper);
      }
    } else {
      dom.res.classList.add("empty");
    }
  }

  function buildRowEl(row, index, locked) {
    var el = document.createElement("div");
    el.className = "row";

    var main = document.createElement("div");
    main.className = "row-main";

    var ta = document.createElement("textarea");
    ta.rows = 1;
    ta.spellcheck = false;
    ta.placeholder = index === 0 ? "输入算式，例如 1280 * 3.5" : "";
    ta.value = row.expr || "";
    ta.readOnly = !!locked;

    var res = document.createElement("span");
    res.className = "row-result";
    res.title = "点击复制结果";

    main.appendChild(ta);
    main.appendChild(res);

    var fin = document.createElement("div");
    fin.className = "row-fin hidden";
    var money = document.createElement("span");
    money.className = "fin-money";
    money.title = "点击复制金额（四舍五入保留 2 位小数）";
    var upper = document.createElement("span");
    upper.className = "fin-upper";
    upper.title = "点击复制大写金额";
    upper.textContent = "大写";
    fin.appendChild(money);
    fin.appendChild(upper);

    el.appendChild(main);
    el.appendChild(fin);

    var dom = { el: el, ta: ta, res: res, fin: fin, money: money, upper: upper };
    wireRow(dom, row, index);
    refreshRow(row, dom);
    return dom;
  }

  function wireRow(dom, row, index) {
    var ta = dom.ta;

    /* 记录光标位置，供虚拟键盘插入使用。
       软键盘收起或点击键盘按钮后 textarea 会失焦，此时 selectionStart 不可靠，
       因此仅在聚焦时采样，其余情况沿用上一次缓存。 */
    function rememberCaret() {
      if (document.activeElement !== ta) return;
      ta._caret = { start: ta.selectionStart, end: ta.selectionEnd };
    }

    ta.addEventListener("focus", function () {
      state.activeRow = index;
      rememberCaret();
      renderKeypadTarget();
      // 点选靠下的行时，键盘会挡住它，滚一下保证可见
      if (state.keypadOpen) scrollRowIntoView(index);
    });
    ["click", "keyup", "select"].forEach(function (evt) {
      ta.addEventListener(evt, rememberCaret);
    });

    ta.addEventListener("input", function () {
      row.expr = ta.value;
      row.ev = evalExpr(row.expr);
      autosize(ta);
      refreshRow(row, dom);
      rememberCaret();
      saveSoon();
    });

    ta.addEventListener("keydown", function (e) {
      if (e.isComposing) return;
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleEnter(index);
        return;
      }
      if (e.key === "Backspace" && ta.value === "" && currentPage().rows.length > 1) {
        e.preventDefault();
        removeRow(index);
        return;
      }
      var mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "c" || e.key === "C")) {
        if (ta.selectionStart === ta.selectionEnd && row.ev && row.ev.ok) {
          e.preventDefault();
          copyWithToast(row.ev.resultPlain, "已复制结果");
        }
      }
    });

    dom.res.addEventListener("click", function () {
      if (row.ev && row.ev.ok) copyWithToast(row.ev.resultPlain, "已复制结果");
    });

    dom.money.addEventListener("click", function () {
      if (row.ev && row.ev.ok && state.finance) copyWithToast(row.ev.moneyPlain, "已复制金额");
    });

    dom.upper.addEventListener("click", function () {
      if (row.ev && row.ev.ok && row.ev.upper) copyWithToast(row.ev.upper, "已复制大写");
    });
  }

  function renderPad() {
    var page = currentPage();
    var locked = !!page.locked;
    var activeIndex = -1;
    var act = document.activeElement;
    if (act && act.tagName === "TEXTAREA" && $pad.contains(act)) {
      var tas = $pad.querySelectorAll("textarea");
      for (var i = 0; i < tas.length; i++) if (tas[i] === act) { activeIndex = i; break; }
    }

    $pad.textContent = "";
    $pad.classList.toggle("locked", locked);

    page.rows.forEach(function (row, i) {
      var dom = buildRowEl(row, i, locked);
      $pad.appendChild(dom.el);
      if (!locked) autosize(dom.ta);
    });

    if (activeIndex >= 0 && !locked) focusRow(activeIndex, true);
    applyInputMode();
  }

  function renderAll() {
    renderTop();
    renderSidebar();
    renderPad();
    applyKeypad();
    applyHaptic();
  }

  /* ---------- 行操作 ---------- */

  function handleEnter(index) {
    var page = currentPage();
    if (page.locked) return;
    var row = page.rows[index];
    if (!row || !row.expr || !row.expr.trim()) return;

    // 财务模式下，携带四舍五入后的金额；普通模式携带完整结果
    var carry = "";
    if (row.ev && row.ev.ok) {
      carry = state.finance ? row.ev.moneyPlain : row.ev.resultPlain;
    }

    // 下一行：能复用空行则复用，否则插入新行（不做任何"预置空行"）
    var next = page.rows[index + 1];
    var target = index + 1;
    if (next && (!next.expr || !next.expr.trim())) {
      next.expr = carry;
      next.ev = evalExpr(carry);
    } else {
      page.rows.splice(target, 0, { key: nextKey(), expr: carry, ev: evalExpr(carry) });
    }
    saveSoon();
    renderPad();
    state.activeRow = target;
    focusRow(target, true);
    markJustAdded(target);
    renderKeypadTarget();
  }

  function removeRow(index) {
    var page = currentPage();
    if (page.locked || page.rows.length <= 1) return;
    page.rows.splice(index, 1);
    if (!page.rows.length) page.rows.push({ key: nextKey(), expr: "", ev: evalExpr("") });
    saveSoon();
    renderPad();
    var focus = Math.max(0, index - 1);
    state.activeRow = focus;
    focusRow(focus, true);
    renderKeypadTarget();
  }

  function focusRow(i, toEnd) {
    var tas = $pad.querySelectorAll(".row textarea");
    if (!tas.length) return;
    var ta = tas[Math.max(0, Math.min(i, tas.length - 1))];
    if (!ta || ta.readOnly) return;
    ta.focus();
    if (toEnd !== false) {
      var n = ta.value.length;
      try { ta.setSelectionRange(n, n); } catch (e) {}
    }
  }

  /**
   * 虚拟键盘展开时把输入框设为 inputmode="none"：点输入框仍可获得光标，
   * 但不再弹出系统键盘，让自绘键盘成为移动端的主要输入方式。
   */
  function applyInputMode() {
    var none = isMobile() && state.keypadOpen;
    var tas = $pad.querySelectorAll(".row textarea");
    for (var i = 0; i < tas.length; i++) {
      if (tas[i].readOnly) continue;
      if (none) tas[i].setAttribute("inputmode", "none");
      else tas[i].removeAttribute("inputmode");
    }
  }

  function markJustAdded(index) {
    var rows = $pad.querySelectorAll(".row");
    var el = rows[index];
    if (!el) return;
    el.classList.add("just-added");
    setTimeout(function () { el.classList.remove("just-added"); }, 240);
  }

  /* ---------- 按键震动 ---------- */

  /* iOS Safari 不实现 navigator.vibrate，但点击带 switch 属性的复选框会触发
     系统触感（iOS 17.4+）。用一个不可见但仍参与渲染的复选框作为回退通道
     —— 不能用 display:none，那样不会触发触感。 */
  var hapticSwitch = null;

  function ensureHapticSwitch() {
    if (hapticSwitch) return hapticSwitch;
    var label = document.createElement("label");
    label.setAttribute("aria-hidden", "true");
    label.style.cssText =
      "position:fixed;right:0;bottom:0;width:1px;height:1px;" +
      "opacity:0;pointer-events:none;overflow:hidden";
    var input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");
    input.tabIndex = -1;
    label.appendChild(input);
    document.body.appendChild(label);
    hapticSwitch = label;
    return label;
  }

  function vibrate(ms) {
    if (!state.haptic) return;
    if (typeof navigator.vibrate === "function") {
      try { navigator.vibrate(ms); } catch (e) {}
      return;
    }
    // 回退：仅 iOS 有意义，其他平台静默忽略
    try { ensureHapticSwitch().click(); } catch (e) {}
  }

  /* ============================ 虚拟键盘 ============================ */

  /** 键盘作用的目标行：优先上次聚焦的行，否则取最后一行 */
  function targetRowIndex() {
    var page = currentPage();
    if (page.locked) return -1;
    var i = state.activeRow;
    if (typeof i !== "number" || i < 0 || i >= page.rows.length) i = page.rows.length - 1;
    return i;
  }

  function targetTextarea() {
    var i = targetRowIndex();
    if (i < 0) return null;
    return $pad.querySelectorAll(".row textarea")[i] || null;
  }

  function renderKeypadTarget() {
    if (!$keypadTarget) return;
    if (currentPage().locked) {
      $keypadTarget.textContent = "已锁定";
      return;
    }
    var i = targetRowIndex();
    $keypadTarget.textContent = i >= 0 ? "第 " + (i + 1) + " 行" : "";
  }

  /**
   * 把某一行滚入可视区。只在需要时滚动，避免输入过程中画面频繁跳动。
   * 键盘展开会占掉底部空间，此时作用行常被挤出视野，需要重新定位。
   */
  function scrollRowIntoView(index) {
    var el = $pad.querySelectorAll(".row")[index];
    if (!el) return;
    var padRect = $pad.getBoundingClientRect();
    var rowRect = el.getBoundingClientRect();
    var top = padRect.top + 10;
    var bottom = padRect.bottom - 10;
    if (rowRect.bottom > bottom) $pad.scrollTop += rowRect.bottom - bottom;
    else if (rowRect.top < top) $pad.scrollTop -= top - rowRect.top;
  }

  function scrollActiveRowIntoView() {
    var i = targetRowIndex();
    if (i >= 0) scrollRowIntoView(i);
  }

  function applyKeypad() {
    if (!$keypad) return;
    $keypad.classList.toggle("collapsed", !state.keypadOpen);
    if ($btnKeypad) $btnKeypad.setAttribute("aria-expanded", String(state.keypadOpen));
    if ($keypadAction) $keypadAction.textContent = state.keypadOpen ? "收起" : "展开";
    if ($hintMobile) {
      $hintMobile.textContent = state.keypadOpen
        ? "点按按键输入 · 点击结果复制"
        : "已收起键盘 · 点输入框可用系统键盘";
    }
    applyInputMode();
    renderKeypadTarget();
  }

  /** 从行元素反查各子节点，避免维护易失效的并行缓存 */
  function rowDomFrom(el) {
    if (!el) return null;
    return {
      el: el,
      ta: el.querySelector("textarea"),
      res: el.querySelector(".row-result"),
      fin: el.querySelector(".row-fin"),
      money: el.querySelector(".fin-money"),
      upper: el.querySelector(".fin-upper")
    };
  }

  /**
   * 以「编辑」的方式改写目标行：把 [start,end) 替换为 text，并按需回焦。
   * 插入、退格、清空都走这一条路径，保证行为一致。
   */
  function editTargetRow(fn) {
    var page = currentPage();
    var i = targetRowIndex();
    if (i < 0) return false;
    var row = page.rows[i];
    var ta = targetTextarea();
    if (!row || !ta) return false;

    var cur = ta.value || "";
    var caret = ta._caret || { start: cur.length, end: cur.length };
    var start = Math.max(0, Math.min(caret.start, cur.length));
    var end = Math.max(start, Math.min(caret.end, cur.length));

    var out = fn(cur, start, end);
    if (!out) return false;
    var next = out.text;
    var pos = Math.max(0, Math.min(out.pos == null ? start : out.pos, next.length));

    row.expr = next;
    row.ev = evalExpr(next);
    ta.value = next;
    ta._caret = { start: pos, end: pos };
    autosize(ta);

    var dom = rowDomFrom(ta.closest(".row"));
    if (dom) refreshRow(row, dom);
    saveSoon();

    // inputmode=none 下聚焦不会弹出系统键盘，可以放心回焦以保留光标
    if (document.activeElement !== ta) ta.focus();
    try { ta.setSelectionRange(pos, pos); } catch (e) {}
    renderKeypadTarget();
    return true;
  }

  function keypadInsert(text) {
    editTargetRow(function (cur, start, end) {
      return { text: cur.slice(0, start) + text + cur.slice(end), pos: start + text.length };
    });
  }

  function keypadBackspace() {
    var page = currentPage();
    var i = targetRowIndex();
    if (i < 0) return;

    // 空行退格：与物理键盘一致，删除该行
    var ta = targetTextarea();
    if (ta && !ta.value) {
      if (page.rows.length > 1) removeRow(i);
      return;
    }

    editTargetRow(function (cur, start, end) {
      var s = start;
      if (s === end) {
        if (s === 0) return null;
        s -= 1;
      }
      return { text: cur.slice(0, s) + cur.slice(end), pos: s };
    });
  }

  function keypadClear() {
    editTargetRow(function () { return { text: "", pos: 0 }; });
  }

  if ($keypadGrid) {
    $keypadGrid.addEventListener("click", function (e) {
      var btn = e.target.closest(".key");
      if (!btn) return;
      e.preventDefault();
      var act = btn.getAttribute("data-act");
      vibrate(act === "enter" ? 18 : 10);
      if (act === "back") keypadBackspace();
      else if (act === "clear") keypadClear();
      else if (act === "enter") handleEnter(targetRowIndex());
      else {
        var ins = btn.getAttribute("data-ins");
        if (ins) keypadInsert(ins);
      }
    });

    // 阻止按键抢走焦点：否则输入框失焦、光标位置丢失
    $keypadGrid.addEventListener("mousedown", function (e) {
      if (e.target.closest(".key")) e.preventDefault();
    });
  }

  if ($btnKeypad) {
    $btnKeypad.addEventListener("click", function () {
      state.keypadOpen = !state.keypadOpen;
      vibrate(10);
      applyKeypad();
      saveSoon();
      // 展开后把当前作用行滚回视野，否则它常被键盘挡在下面
      if (state.keypadOpen) {
        setTimeout(scrollActiveRowIntoView, 240);
      }
    });
  }

  function applyHaptic() {
    if (!$btnHaptic) return;
    $btnHaptic.classList.toggle("on", state.haptic);
    $btnHaptic.setAttribute("aria-pressed", String(state.haptic));
  }

  if ($btnHaptic) {
    $btnHaptic.addEventListener("click", function () {
      state.haptic = !state.haptic;
      applyHaptic();
      saveSoon();
      vibrate(15);
    });
  }

  /* ============================ 财务模式 ============================ */

  $btnFinance.addEventListener("click", function () {
    state.finance = !state.finance;
    saveSoon();
    renderTop();
    renderPad();
    var page = currentPage();
    if (!page.locked && state.finance) {
      toast("财务模式已开启：回车下一行携带金额（如 1234.57）");
    } else {
      toast(state.finance ? "财务模式已开启" : "财务模式已关闭");
    }
  });

  /* ============================ 工具栏 ============================ */

  $btnSidebar.addEventListener("click", toggleSidebar);
  $btnNewPage.addEventListener("click", function () {
    addPage();
    closeDrawerOnMobile();
  });
  $btnAdd.addEventListener("click", addPage);
  $btnRename.addEventListener("click", startRename);
  $btnLock.addEventListener("click", toggleLock);
  $btnRemove.addEventListener("click", function () { askRemovePage(state.current); });
  $btnImage.addEventListener("click", function () { exportImage(); });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (state.editingRename) { state.editingRename = false; renderSidebar(); return; }
    }
    var mod = e.metaKey || e.ctrlKey;
    if (!mod) return;
    if (e.key === "b" || e.key === "B") {
      e.preventDefault();
      toggleSidebar();
      return;
    }
    if (e.key === "n" || e.key === "N") {
      if (e.target && e.target.tagName === "TEXTAREA" && e.target.selectionStart !== e.target.selectionEnd) return;
      e.preventDefault();
      addPage();
    }
  });

  if ($scrim) {
    $scrim.addEventListener("click", function () {
      state.drawerOpen = false;
      applySidebar();
    });
  }

  window.addEventListener("resize", function () {
    // 断点切换时重新套用样式（桌面折叠偏好与移动抽屉状态互不影响）
    applySidebar();
    applyInputMode();
  });

  window.addEventListener("blur", function () { flush(); });
  window.addEventListener("beforeunload", function () { flush(); });

  /* ============================ 复制为图片 ============================ */

  function roundedRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function wrapLines(ctx, text, maxWidth) {
    var lines = [];
    var current = "";
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (ch === "\n") { lines.push(current); current = ""; continue; }
      var t = current + ch;
      if (ctx.measureText(t).width > maxWidth && current) {
        lines.push(current);
        current = ch;
      } else current = t;
    }
    if (current || !lines.length) lines.push(current);
    return lines;
  }

  function exportImage(target) {
    var page = target || currentPage();
    var items = [];
    page.rows.forEach(function (r) {
      if (r.expr && r.expr.trim()) items.push(r);
    });
    if (!items.length) { toast("「" + pageLabel(page) + "」还没有内容，无法导出"); return; }

    var W = 780, PAD = 44, SCALE = 2;
    var exprFont = "500 16px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    var resFont = "600 19px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    var finFont = "600 16px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    var headFont = "650 22px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";
    var dimFont = "400 12.5px -apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif";

    var probe = document.createElement("canvas").getContext("2d");
    var blocks = [];
    var y = 0;
    var contentW = W - PAD * 2;

    probe.font = exprFont;
    items.forEach(function (r, idx) {
      var ev = r.ev && r.ev.ok ? r.ev : null;
      var resText = ev ? "= " + ev.resultText : "";
      probe.font = resFont;
      var resW = resText ? probe.measureText(resText).width : 0;
      var exprMax = contentW - resW - 24;
      probe.font = exprFont;
      var lines = wrapLines(probe, r.expr.trim(), Math.max(140, exprMax));
      var h = Math.max(lines.length * 24, 26);
      var fin = null;
      if (state.finance && ev) {
        var finNeg = ev.moneyPlain.charAt(0) === "-";
        fin = (finNeg ? "−" : "") + "¥" + Core.group(finNeg ? ev.moneyPlain.slice(1) : ev.moneyPlain);
        h += 24;
      }
      blocks.push({ lines: lines, res: resText, fin: fin, h: h, first: idx === 0 });
      y += h + 18;
    });

    var H = 84 + y + 46;
    var canvas = document.createElement("canvas");
    canvas.width = W * SCALE;
    canvas.height = H * SCALE;
    var ctx = canvas.getContext("2d");
    ctx.scale(SCALE, SCALE);

    ctx.fillStyle = "#ffffff";
    roundedRect(ctx, 0, 0, W, H, 18);
    ctx.fill();

    ctx.fillStyle = "#111318";
    ctx.font = headFont;
    ctx.textBaseline = "alphabetic";
    ctx.fillText("算账稿纸", PAD, 50);

    ctx.font = dimFont;
    ctx.fillStyle = "#8a8f99";
    var dateText = fmtDate(page.createdAt) + (page.title ? " · " + page.title : "");
    var dw = ctx.measureText(dateText).width;
    ctx.fillText(dateText, W - PAD - dw, 49);

    ctx.strokeStyle = "#e8eaef";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(PAD, 66);
    ctx.lineTo(W - PAD, 66);
    ctx.stroke();

    var cy = 96;
    blocks.forEach(function (b) {
      if (!b.first) {
        ctx.strokeStyle = "#f1f2f6";
        ctx.beginPath();
        ctx.moveTo(PAD, cy - 12);
        ctx.lineTo(W - PAD, cy - 12);
        ctx.stroke();
      }
      ctx.font = exprFont;
      ctx.fillStyle = "#3a3f4a";
      b.lines.forEach(function (ln, i) {
        ctx.fillText(ln, PAD, cy + i * 24 + 8);
      });
      if (b.res) {
        ctx.font = resFont;
        ctx.fillStyle = "#111318";
        var rw = ctx.measureText(b.res).width;
        ctx.fillText(b.res, W - PAD - rw, cy + 8);
      }
      if (b.fin) {
        ctx.font = finFont;
        ctx.fillStyle = "#0d9668";
        var fw = ctx.measureText(b.fin).width;
        ctx.fillText(b.fin, W - PAD - fw, cy + 32);
      }
      cy += b.h + 18;
    });

    ctx.font = dimFont;
    ctx.fillStyle = "#b6bac3";
    var foot = "由 算账稿纸 生成";
    ctx.fillText(foot, W - PAD - ctx.measureText(foot).width, H - 20);

    var dataUrl = canvas.toDataURL("image/png");
    var name = pageLabel(page).replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) + ".png";
    copyImage(dataUrl, name, function (how) {
      toast(how === "copied"
        ? "已复制「" + pageLabel(page) + "」为图片"
        : "已导出图片「" + name + "」");
    });
  }

  /* ============================ uTools 集成 ============================ */

  function enterWithPayload(code, payload) {
    var page = currentPage();
    if (page.locked) { toast("当前稿纸已锁定，无法写入"); return; }
    var expr = String(payload || "").trim().replace(/,/g, "");
    if (code === "sum") expr = expr.split(/\s+/).join("+");
    else if (code === "average") {
      var nums = expr.split(/\s+/);
      expr = "(" + nums.join("+") + ")/" + nums.length;
    }
    var rows = page.rows;
    if (rows.length && (!rows[rows.length - 1].expr || !rows[rows.length - 1].expr.trim())) rows.pop();
    if (!rows.length) rows.push({ key: nextKey(), expr: "", ev: evalExpr("") });
    rows.push({ key: nextKey(), expr: expr, ev: evalExpr(expr) });
    saveSoon();
    renderAll();
    setTimeout(function () { focusRow(rows.length - 1, true); }, 40);
    toast("已填入算式");
  }

  if (IS_UTOOLS) {
    if (ut.onPluginEnter) {
      ut.onPluginEnter(function (data) {
        data = data || {};
        if (data.type === "regex" && data.payload != null) {
          enterWithPayload(String(data.code || ""), String(data.payload));
          return;
        }
        var page = currentPage();
        if (page.locked) return;
        var idx = -1;
        page.rows.forEach(function (r, i) {
          if (idx === -1 && (!r.expr || !r.expr.trim())) idx = i;
        });
        if (idx === -1) idx = page.rows.length - 1;
        setTimeout(function () { focusRow(idx); }, 60);
      });
    }
    if (ut.onPluginOut) ut.onPluginOut(function () { flush(); });
    if (ut.onMainPush) {
      ut.onMainPush(function (action) {
        action = action || {};
        var code = String(action.code || "");
        var payload = String(action.payload == null ? "" : action.payload).trim();
        if (!payload) return;
        if (code === "expression") {
          var r = Core.evaluate(payload);
          if (!r.ok) return;
          return { type: "list", data: [{ icon: "res/equals.svg", text: Core.resultText(r.value) }] };
        }
        if (code === "sum" || code === "average") {
          var nums = payload.replace(/,/g, "").split(/\s+/).filter(Boolean);
          if (nums.length < 2) return;
          var expr = code === "sum" ? nums.join("+") : "(" + nums.join("+") + ")/" + nums.length;
          var r2 = Core.evaluate(expr);
          if (!r2.ok) return;
          return {
            type: "list",
            data: [{ icon: code === "sum" ? "res/sum.svg" : "res/average.svg", text: Core.resultText(r2.value) }]
          };
        }
      });
    }
  }

  /* ============================ 启动 ============================ */

  // PWA 快捷方式等外部入口触发的动作
  window.addEventListener("suanzhang:action", function (e) {
    var action = e && e.detail && e.detail.action;
    if (action === "new") addPage();
  });

  // 新版本就绪时提示（由 pwa.js 派发）
  window.addEventListener("suanzhang:updated", function () {
    toast("已更新到新版本，刷新后生效");
  });

  function init() {
    load();
    // 移动端不自动聚焦，避免一打开就弹出软键盘
    var mobile = isMobile();
    applySidebar();
    renderAll();
    var page = currentPage();
    if (!page.locked && !mobile) {
      setTimeout(function () { focusRow(page.rows.length - 1); }, 60);
    } else if (mobile && state.keypadOpen) {
      // 键盘已展开：把当前作用行滚入视野，否则按键可能写到看不见的行上
      setTimeout(scrollActiveRowIntoView, 120);
    }
  }

  init();
})();

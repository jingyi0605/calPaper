/*!
 * 算账稿纸 · PWA 引导
 * ------------------------------------------------------------
 * · 注册 Service Worker（仅 http/https；file:// 下静默跳过，功能不受影响）
 * · 处理 manifest 快捷方式 ?action=new
 * · 发现新版本时自动激活并重载一次
 */
(function () {
  "use strict";

  var isFile = location.protocol === "file:";
  var canSW = "serviceWorker" in navigator && !isFile;

  /* ---------- 快捷方式：新建稿纸 ---------- */
  function handleAction() {
    var params = new URLSearchParams(location.search);
    if (params.get("action") !== "new") return;
    // 交给 app.js 的按钮逻辑，保证与点击「新建稿纸」完全一致
    window.dispatchEvent(new CustomEvent("suanzhang:action", { detail: { action: "new" } }));
    params.delete("action");
    var qs = params.toString();
    try {
      // file:// 下部分浏览器会拒绝改写历史
      history.replaceState(null, "", location.pathname + (qs ? "?" + qs : "") + location.hash);
    } catch (e) {}
  }

  /* ---------- Service Worker ---------- */
  if (canSW) {
    window.addEventListener("load", function () {
      navigator.serviceWorker.register("sw.js").then(function (reg) {
        reg.addEventListener("updatefound", function () {
          var sw = reg.installing;
          if (!sw) return;
          sw.addEventListener("statechange", function () {
            // 已有旧版本在控制页面时才提示刷新，避免首次安装触发重载
            if (sw.state === "installed" && navigator.serviceWorker.controller) {
              window.dispatchEvent(new CustomEvent("suanzhang:updated"));
            }
          });
        });
      }).catch(function () {
        // 注册失败（如不支持的浏览器）不影响核心功能
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", handleAction);
  } else {
    handleAction();
  }
})();

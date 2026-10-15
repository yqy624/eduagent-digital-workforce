/* ==========================================================================
   高保真原型 · 交互引擎 hifi.js
   --------------------------------------------------------------------------
   全部交互走声明式 data-* 属性，无需写业务 JS：
     路由     data-goto="p2" / data-back
     设备     data-device-btn="desktop|tablet|mobile"
     主题     data-theme-dot="saas|mobile|commerce|brand"
     弹层     data-modal-open="#id" / data-drawer-open="#id" / data-sheet-open="#id"
              data-menu-open="#id" / data-close
     标签页   容器 [data-tabs] 内：.tab[data-tab=k] + .tab-panel[data-panel=k]
     分段     容器 [data-seg] 内：.seg-item[data-seg-key]
     表单     form[data-validate] + data-required / data-type / data-min /
              data-max / data-pattern / data-eq / data-msg
     加载     data-loading[="ms"] data-loading-done="提示文案"
     轻提示   data-toast="文案" data-toast-type="success|error|warn"
     表格     th[data-sort] 排序；[data-select-all] 全选
     数字     data-count-to="1280" data-prefix="¥" data-suffix="+" data-decimals
     进度     data-progress="72"
     倒计时   data-countdown="3600"（渲染 .cd-h/.cd-m/.cd-s）
     骨架     data-skeleton="#target" data-skeleton-ms="1500"
     其他     data-fav（收藏）、data-sidebar-toggle（抽屉导航）
   ========================================================================== */
(function () {
  "use strict";

  /* ---------------------------------------------------------------- 图标库 */
  var ICONS = {
    "home": '<path d="M3 10.5L12 3l9 7.5"/><path d="M5 9.7V21h14V9.7"/><path d="M9.5 21v-6h5v6"/>',
    "search": '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>',
    "bell": '<path d="M6 9a6 6 0 1 1 12 0c0 5 2 6.5 2 6.5H4S6 14 6 9z"/><path d="M10 19a2.2 2.2 0 0 0 4 0"/>',
    "user": '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5c1.2-3.8 4-5.5 7.5-5.5s6.3 1.7 7.5 5.5"/>',
    "users": '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20c1-3.2 3.4-4.8 6.5-4.8s5.5 1.6 6.5 4.8"/><path d="M16 5.6a3.5 3.5 0 0 1 0 5.8"/><path d="M18 15.6c1.9.8 3 2.3 3.5 4.4"/>',
    "settings": '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3h.1a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    "menu": '<path d="M4 7h16M4 12h16M4 17h16"/>',
    "x": '<path d="M6 6l12 12M18 6L6 18"/>',
    "plus": '<path d="M12 5v14M5 12h14"/>',
    "minus": '<path d="M5 12h14"/>',
    "check": '<path d="M4.5 12.5l5 5 10-11"/>',
    "check-circle": '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l2.7 2.7L16.5 9"/>',
    "x-circle": '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
    "info": '<circle cx="12" cy="12" r="9"/><path d="M12 11v5"/><path d="M12 8h.01"/>',
    "alert-triangle": '<path d="M12 3.5L22 20H2L12 3.5z"/><path d="M12 10v4"/><path d="M12 17h.01"/>',
    "edit": '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17l-1 4z"/><path d="M14.5 6.5l3 3"/>',
    "trash": '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 14h10l1-14"/><path d="M10 11v6M14 11v6"/>',
    "download": '<path d="M12 4v11M7 10l5 5 5-5"/><path d="M4 20h16"/>',
    "upload": '<path d="M12 15V4M7 9l5-5 5 5"/><path d="M4 20h16"/>',
    "filter": '<path d="M4 5h16l-6 7v6l-4 2v-8L4 5z"/>',
    "calendar": '<rect x="3.5" y="5" width="17" height="16" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    "clock": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
    "mail": '<rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="M3.5 7l8.5 6 8.5-6"/>',
    "phone": '<path d="M5 4h4l2 5-2.5 1.5a12 12 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
    "star": '<path d="M12 3.6l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 17l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9L12 3.6z"/>',
    "heart": '<path d="M12 20.5S3.5 15.5 3.5 9.3A4.8 4.8 0 0 1 12 6.4a4.8 4.8 0 0 1 8.5 2.9c0 6.2-8.5 11.2-8.5 11.2z"/>',
    "cart": '<circle cx="9" cy="20" r="1.6"/><circle cx="17" cy="20" r="1.6"/><path d="M3 4h2.5l2.2 11h9.8l2-8H6.2"/>',
    "tag": '<path d="M3.5 12.5v-9h9L21 12l-8.5 8.5L3.5 12.5z"/><circle cx="8" cy="8" r="1.4"/>',
    "map-pin": '<path d="M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11z"/><circle cx="12" cy="10" r="2.6"/>',
    "credit-card": '<rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 10h19"/>',
    "chart": '<path d="M4 19V5"/><path d="M4 19h16"/><path d="M7 14l3.5-4 3 2.5L18 7"/>',
    "bar-chart": '<path d="M5 20v-8M12 20V5M19 20v-5"/>',
    "grid": '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    "list": '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4.5 6h.01M4.5 12h.01M4.5 18h.01"/>',
    "layers": '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 13l9 5 9-5"/>',
    "box": '<path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5v-9z"/><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9"/>',
    "folder": '<path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-11z"/>',
    "file": '<path d="M6 3.5h8l5 5v12H6v-17z"/><path d="M13.5 3.5v5.5H19"/>',
    "image": '<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><circle cx="9" cy="10" r="1.8"/><path d="M3.5 17l5-4 4 3 3.5-3 4.5 4"/>',
    "play": '<path d="M8 5.5v13l11-6.5-11-6.5z"/>',
    "share": '<circle cx="6" cy="12" r="2.6"/><circle cx="18" cy="5.5" r="2.6"/><circle cx="18" cy="18.5" r="2.6"/><path d="M8.4 10.8l7.2-4M8.4 13.2l7.2 4"/>',
    "link": '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11.5 7"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/>',
    "lock": '<rect x="5" y="10.5" width="14" height="10" rx="2.5"/><path d="M8 10.5V8a4 4 0 1 1 8 0v2.5"/>',
    "eye": '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
    "eye-off": '<path d="M4 4l16 16"/><path d="M9.9 5.9A9.4 9.4 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3.2 4M6.6 6.6A16.4 16.4 0 0 0 2.5 12S6 18.5 12 18.5a9 9 0 0 0 5.4-1.9"/><path d="M10 10a3 3 0 0 0 4 4"/>',
    "refresh": '<path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v4h-4"/>',
    "more-h": '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
    "more-v": '<path d="M12 5h.01M12 12h.01M12 19h.01"/>',
    "arrow-left": '<path d="M19 12H5M11 6l-6 6 6 6"/>',
    "arrow-right": '<path d="M5 12h14M13 6l6 6-6 6"/>',
    "arrow-up": '<path d="M12 19V5M6 11l6-6 6 6"/>',
    "arrow-down": '<path d="M12 5v14M6 13l6 6 6-6"/>',
    "chevron-left": '<path d="M14.5 6l-6 6 6 6"/>',
    "chevron-right": '<path d="M9.5 6l6 6-6 6"/>',
    "chevron-down": '<path d="M6 9.5l6 6 6-6"/>',
    "chevron-up": '<path d="M6 14.5l6-6 6 6"/>',
    "trending-up": '<path d="M3 17l6-6 4 4 7-8"/><path d="M15 7h5v5"/>',
    "trending-down": '<path d="M3 7l6 6 4-4 7 8"/><path d="M15 17h5v-5"/>',
    "gift": '<rect x="3.5" y="8" width="17" height="4"/><path d="M5 12v8.5h14V12"/><path d="M12 8v12.5"/><path d="M12 8s-4.5.3-5.5-2C5.6 3.8 9.5 3 10.7 5.3 11.6 7 12 8 12 8z"/><path d="M12 8s4.5.3 5.5-2C18.4 3.8 14.5 3 13.3 5.3 12.4 7 12 8 12 8z"/>',
    "ticket": '<path d="M4 7h16v3.5a1.8 1.8 0 0 0 0 3V17H4v-3.5a1.8 1.8 0 0 0 0-3V7z"/><path d="M14 7v10"/>',
    "zap": '<path d="M13 2L4 14h7v8l9-12h-7V2z"/>',
    "truck": '<path d="M2.5 6h11v10h-11z"/><path d="M13.5 10h4l3 3.5V16h-7"/><circle cx="7" cy="18" r="2"/><circle cx="17" cy="18" r="2"/>',
    "sliders": '<path d="M5 4v6M5 14v6M12 4v2M12 10v10M19 4v10M19 18v2"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="8" r="2"/><circle cx="19" cy="16" r="2"/>',
    "log-out": '<path d="M9 4H5.5A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20H9"/><path d="M15 8l4 4-4 4"/><path d="M19 12H9"/>',
    "message": '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z"/>',
    "thumbs-up": '<path d="M7 10.5v10H4.5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1H7zM7 11l4-7.5A2.2 2.2 0 0 1 13.5 6c0 2-1 3.5-1 4.5h5.6a2 2 0 0 1 2 2.4l-1.2 6a2 2 0 0 1-2 1.6H7"/>',
    "bookmark": '<path d="M6.5 3.5h11V21L12 17l-5.5 4V3.5z"/>',
    "wallet": '<path d="M3.5 7A2.5 2.5 0 0 1 6 4.5h12.5v3"/><path d="M3.5 7v12A1.5 1.5 0 0 0 5 20.5h14a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 19 8.5H5A1.5 1.5 0 0 1 3.5 7z"/><circle cx="16.5" cy="14.5" r="1"/>',
    "sparkles": '<path d="M12 4l1.5 4L18 9.5 13.5 11 12 15l-1.5-4L6 9.5 10.5 8 12 4z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z"/>',
    "target": '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>',
    "shield": '<path d="M12 3l7.5 3v6c0 4.5-3.2 7.6-7.5 9-4.3-1.4-7.5-4.5-7.5-9V6L12 3z"/>',
    "headphones": '<path d="M4 14v-2a8 8 0 1 1 16 0v2"/><rect x="3" y="14" width="4.5" height="6.5" rx="2"/><rect x="16.5" y="14" width="4.5" height="6.5" rx="2"/>',
    "send": '<path d="M21.5 3.5L10 15M21.5 3.5L14 21l-4-6-6-4 17.5-7.5z"/>',
    "scan": '<path d="M4 8V5.5A1.5 1.5 0 0 1 5.5 4H8M16 4h2.5A1.5 1.5 0 0 1 20 5.5V8M20 16v2.5a1.5 1.5 0 0 1-1.5 1.5H16M8 20H5.5A1.5 1.5 0 0 1 4 18.5V16"/><path d="M4 12h16"/>',
    "moon": '<path d="M20 14.5A8.5 8.5 0 1 1 9.5 4 7 7 0 0 0 20 14.5z"/>'
  };

  var DOC = document;
  var app = DOC.querySelector(".app");
  var stage = DOC.querySelector(".stage");

  function $(sel, root) { return (root || DOC).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || DOC).querySelectorAll(sel)); }
  function svgOf(name) { return ICONS[name] || ICONS.info; }

  /* ------------------------------------------------------ 1. 图标注入 */
  function injectIcons(root) {
    $$("[data-icon]", root).forEach(function (el) {
      if (el.__iconDone) return;
      el.__iconDone = true;
      var name = el.getAttribute("data-icon");
      var ns = "http://www.w3.org/2000/svg";
      var svg = DOC.createElementNS(ns, "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      svg.innerHTML = svgOf(name);
      el.appendChild(svg);
    });
  }

  /* ------------------------------------------------------ 2. 涟漪 */
  DOC.addEventListener("pointerdown", function (e) {
    var btn = e.target.closest(".btn, .tabbar-item, .fab, .page-btn");
    if (!btn || btn.disabled) return;
    var rect = btn.getBoundingClientRect();
    var d = Math.max(rect.width, rect.height) * 1.1;
    var r = DOC.createElement("span");
    r.className = "ripple";
    r.style.width = r.style.height = d + "px";
    r.style.left = (e.clientX - rect.left - d / 2) + "px";
    r.style.top = (e.clientY - rect.top - d / 2) + "px";
    btn.appendChild(r);
    setTimeout(function () { r.remove(); }, 620);
  });

  /* ------------------------------------------------------ 3. 路由 */
  var navStack = [];
  var pageInd = $(".stage-page");

  function pageById(id) {
    if (id.charAt(0) === "#") id = id.slice(1);
    return DOC.getElementById(id);
  }
  function setIndicator(page) {
    if (!pageInd) return;
    pageInd.textContent = (page.getAttribute("data-pid") || "") + " · " + (page.getAttribute("data-title") || "");
  }
  function goto(id, noPush) {
    var next = pageById(id);
    if (!next) return;
    var cur = $(".page.is-active");
    if (cur && cur === next) return;
    if (cur && !noPush) navStack.push(cur.id);
    $$(".page.is-active").forEach(function (p) { p.classList.remove("is-active"); });
    next.classList.add("is-active");
    next.scrollTop = 0;
    setIndicator(next);
    $$(".page").forEach(function (p) {
      if (p.classList.contains("is-active")) activateIn(p);
    });
  }
  DOC.addEventListener("click", function (e) {
    var t = e.target.closest("[data-goto]");
    if (t) {
      closeAllOverlays();
      goto(t.getAttribute("data-goto"));
      return;
    }
    var b = e.target.closest("[data-back]");
    if (b) {
      var prev = navStack.pop();
      if (prev) goto(prev, true);
    }
  });

  /* ------------------------------------------------------ 4. 舞台：设备与主题 */
  DOC.addEventListener("click", function (e) {
    var d = e.target.closest("[data-device-btn]");
    if (d && stage) {
      stage.setAttribute("data-device", d.getAttribute("data-device-btn"));
      $$("[data-device-btn]").forEach(function (b) { b.classList.toggle("is-on", b === d); });
    }
    var th = e.target.closest("[data-theme-dot]");
    if (th && app) {
      app.setAttribute("data-theme", th.getAttribute("data-theme-dot"));
      $$("[data-theme-dot]").forEach(function (b) { b.classList.toggle("is-on", b === th); });
      $$(".tab-indicator, .seg-thumb").forEach(function (x) { x.remove(); });
      initTabs(); initSeg();
    }
  });

  /* ------------------------------------------------------ 5. 弹层 */
  var gMask = DOC.createElement("div");
  gMask.className = "mask";
  gMask.setAttribute("data-mask", "");
  if (app) app.appendChild(gMask);
  var openStack = [];

  function overlayOf(sel) {
    var id = sel;
    if (id.charAt(0) === "#") id = id.slice(1);
    return DOC.getElementById(id);
  }
  function openOverlay(el) {
    if (!el) return;
    el.classList.add("open");
    openStack.push(el);
    gMask.classList.add("open");
  }
  function closeOverlay(el) {
    if (!el) return;
    el.classList.remove("open");
    var i = openStack.indexOf(el);
    if (i > -1) openStack.splice(i, 1);
    if (!openStack.length) gMask.classList.remove("open");
  }
  function closeAllOverlays() {
    while (openStack.length) closeOverlay(openStack[openStack.length - 1]);
  }
  DOC.addEventListener("click", function (e) {
    var mo = e.target.closest("[data-modal-open]");
    if (mo) { openOverlay(overlayOf(mo.getAttribute("data-modal-open"))); return; }
    var dr = e.target.closest("[data-drawer-open]");
    if (dr) { openOverlay(overlayOf(dr.getAttribute("data-drawer-open"))); return; }
    var sh = e.target.closest("[data-sheet-open]");
    if (sh) { openOverlay(overlayOf(sh.getAttribute("data-sheet-open"))); return; }
    if (e.target.closest("[data-close]")) {
      var ov = e.target.closest(".modal, .drawer, .sheet, .mask");
      closeOverlay(ov || openStack[openStack.length - 1]);
      return;
    }
    if (e.target.closest("[data-mask]")) { closeAllOverlays(); return; }
  });
  DOC.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && openStack.length) {
      closeOverlay(openStack[openStack.length - 1]);
    }
  });

  /* 菜单（下拉） */
  DOC.addEventListener("click", function (e) {
    var mo = e.target.closest("[data-menu-open]");
    if (mo) {
      var m = overlayOf(mo.getAttribute("data-menu-open"));
      if (m) {
        var willOpen = !m.classList.contains("open");
        $$(".menu.open").forEach(function (x) { x.classList.remove("open"); });
        if (willOpen) {
          /* 菜单交给 .app 定位（app 有 containment，absolute 以其为基准） */
          if (app && m.parentElement !== app) app.appendChild(m);
          m.classList.add("open");
          var host = mo.closest(".tooltip-host") || mo;
          var r = host.getBoundingClientRect();
          var ar = app.getBoundingClientRect();
          var left = Math.min(Math.max(6, r.left - ar.left), ar.width - m.offsetWidth - 6);
          var top = r.bottom - ar.top + 6;
          if (top + m.offsetHeight > ar.height - 6) top = r.top - ar.top - m.offsetHeight - 6;
          m.style.left = left + "px";
          m.style.top = top + "px";
          m.style.right = "auto";
        }
      }
      return;
    }
    if (!e.target.closest(".menu")) {
      $$(".menu.open").forEach(function (x) { x.classList.remove("open"); });
    }
  });

  /* ------------------------------------------------------ 6. Tabs */
  function placeIndicator(tabs, ind, on) {
    if (!tabs || !ind || !on) return;
    ind.style.width = on.offsetWidth + "px";
    ind.style.transform = "translateX(" + on.offsetLeft + "px)";
  }
  function initTabs() {
    $$("[data-tabs]").forEach(function (box) {
      var tabs = $$(".tab", box);
      if (!tabs.length) return;
      var row = $(".tabs", box) || tabs[0].parentElement;
      var ind = $(".tab-indicator", row);
      if (!ind) {
        ind = DOC.createElement("span");
        ind.className = "tab-indicator";
        row.appendChild(ind);
      }
      function activate(key, silent) {
        tabs.forEach(function (t) { t.classList.toggle("is-on", t.getAttribute("data-tab") === key); });
        $$("[data-panel]", box).forEach(function (p) {
          p.classList.toggle("is-on", p.getAttribute("data-panel") === key);
        });
        placeIndicator(row, ind, $('.tab.is-on', box));
        if (!silent) $$(".tab-panel.is-on", box).forEach(activateIn);
      }
      if (!row.__tabBound) {
        row.__tabBound = true;
        row.addEventListener("click", function (e) {
          var t = e.target.closest(".tab");
          if (t) activate(t.getAttribute("data-tab"));
        });
      }
      var on = $(".tab.is-on", box) || tabs[0];
      activate(on.getAttribute("data-tab"), true);
    });
  }

  /* ------------------------------------------------------ 7. 分段控件 */
  function initSeg() {
    $$("[data-seg]").forEach(function (box) {
      var row = $(".seg", box);
      if (!row) return;
      var items = $$(".seg-item", row);
      if (!items.length) return;
      var thumb = $(".seg-thumb", row);
      if (!thumb) {
        thumb = DOC.createElement("span");
        thumb.className = "seg-thumb";
        row.insertBefore(thumb, items[0]);
      }
      function place(on) {
        if (!on) return;
        thumb.style.width = on.offsetWidth + "px";
        thumb.style.transform = "translateX(" + (on.offsetLeft - 3) + "px)";
      }
      if (!row.__segBound) {
        row.__segBound = true;
        row.addEventListener("click", function (e) {
          var it = e.target.closest(".seg-item");
          if (!it) return;
          items.forEach(function (x) { x.classList.toggle("is-on", x === it); });
          place(it);
          var panelKey = it.getAttribute("data-seg-panel");
          if (panelKey) {
            $$("[data-seg-view]", box).forEach(function (v) {
              v.classList.toggle("is-on", v.getAttribute("data-seg-view") === panelKey);
            });
          }
        });
      }
      place($(".seg-item.is-on", row) || items[0]);
    });
  }

  /* ------------------------------------------------------ 8. 轻提示 */
  var toastWrap = DOC.createElement("div");
  toastWrap.className = "toast-wrap";
  if (app) app.appendChild(toastWrap);
  var T_ICONS = { success: "check-circle", error: "x-circle", warn: "alert-triangle", info: "info" };

  function toast(msg, type) {
    var t = DOC.createElement("div");
    t.className = "toast" + (type && type !== "success" ? " " + type : "");
    var ic = DOC.createElement("span");
    ic.className = "t-ic";
    ic.setAttribute("data-icon", T_ICONS[type] || "check-circle");
    t.appendChild(ic);
    t.appendChild(DOC.createTextNode(msg));
    toastWrap.appendChild(t);
    injectIcons(t);
    setTimeout(function () {
      t.classList.add("out");
      setTimeout(function () { t.remove(); }, 240);
    }, 2300);
  }

  DOC.addEventListener("click", function (e) {
    var el = e.target.closest("[data-toast]");
    if (el) toast(el.getAttribute("data-toast"), el.getAttribute("data-toast-type") || "success");
  });

  /* ------------------------------------------------------ 9. 加载态 */
  DOC.addEventListener("click", function (e) {
    var el = e.target.closest("[data-loading]");
    if (!el || el.classList.contains("is-loading")) return;
    var ms = parseInt(el.getAttribute("data-loading"), 10) || 1200;
    var done = el.getAttribute("data-loading-done");
    el.classList.add("is-loading");
    setTimeout(function () {
      el.classList.remove("is-loading");
      if (done) toast(done, "success");
    }, ms);
  });

  /* ------------------------------------------------------ 10. 表单校验 */
  var TYPES = {
    email: { re: /^[^\s@]+@[^\s@]+\.[^\s@]+$/, msg: "邮箱格式不正确" },
    phone: { re: /^1[3-9]\d{9}$/, msg: "手机号格式不正确" },
    number: { re: /^-?\d+(\.\d+)?$/, msg: "请输入数字" },
    idcard: { re: /^\d{17}[\dXx]$/, msg: "身份证号格式不正确" }
  };
  function fieldOf(input) { return input.closest(".field"); }
  function setErr(input, msg) {
    var f = fieldOf(input);
    if (!f) { toast(msg, "error"); return; }
    f.classList.add("has-error");
    var m = $(".field-msg", f);
    if (m) m.textContent = msg;
  }
  function validateInput(input) {
    var f = fieldOf(input);
    if (f) f.classList.remove("has-error");
    var v = (input.type === "checkbox") ? (input.checked ? "1" : "") : input.value.trim();
    if (input.hasAttribute("data-required") && !v) {
      setErr(input, input.getAttribute("data-msg") || "此项为必填项");
      return false;
    }
    if (!v) return true;
    var type = input.getAttribute("data-type");
    if (type && TYPES[type] && !TYPES[type].re.test(v)) {
      setErr(input, input.getAttribute("data-msg") || TYPES[type].msg);
      return false;
    }
    var p = input.getAttribute("data-pattern");
    if (p && !(new RegExp(p)).test(v)) {
      setErr(input, input.getAttribute("data-msg") || "格式不正确");
      return false;
    }
    var mn = input.getAttribute("data-min");
    if (mn && v.length < parseInt(mn, 10)) {
      setErr(input, input.getAttribute("data-msg") || "至少 " + mn + " 个字符");
      return false;
    }
    var mx = input.getAttribute("data-max");
    if (mx && v.length > parseInt(mx, 10)) {
      setErr(input, input.getAttribute("data-msg") || "最多 " + mx + " 个字符");
      return false;
    }
    var eq = input.getAttribute("data-eq");
    if (eq) {
      var other = overlayOf(eq) || DOC.querySelector(eq);
      if (other && other.value !== v) {
        setErr(input, input.getAttribute("data-msg") || "两次输入不一致");
        return false;
      }
    }
    return true;
  }
  DOC.addEventListener("submit", function (e) {
    var form = e.target.closest("form[data-validate]");
    if (!form) return;
    e.preventDefault();
    var inputs = $$("[data-required], [data-type], [data-pattern], [data-min], [data-max], [data-eq]", form);
    var ok = true;
    inputs.forEach(function (i) { if (!validateInput(i)) ok = false; });
    if (!ok) {
      var first = $(".field.has-error", form);
      if (first) first.scrollIntoView({ behavior: "smooth", block: "center" });
      return;
    }
    var done = form.getAttribute("data-success-toast");
    if (done) toast(done, "success");
    var reset = form.getAttribute("data-reset") !== "off";
    if (reset) form.reset();
  });
  DOC.addEventListener("input", function (e) {
    var input = e.target;
    if (!input.closest("form[data-validate]")) return;
    var f = fieldOf(input);
    if (f && f.classList.contains("has-error")) validateInput(input);
  });

  /* ------------------------------------------------------ 11. 表格：排序与全选 */
  DOC.addEventListener("click", function (e) {
    var th = e.target.closest("th[data-sort]");
    if (!th) return;
    var table = th.closest("table");
    var tbody = table.querySelector("tbody");
    if (!tbody) return;
    var idx = Array.prototype.indexOf.call(th.parentElement.children, th);
    var desc = th.classList.contains("is-sorted") && !th.classList.contains("is-desc");
    $$("th[data-sort]", table).forEach(function (x) { x.classList.remove("is-sorted", "is-desc"); });
    th.classList.add("is-sorted");
    if (desc) th.classList.add("is-desc");
    var rows = $$("tr", tbody);
    rows.sort(function (a, b) {
      var av = a.children[idx].textContent.trim();
      var bv = b.children[idx].textContent.trim();
      var an = parseFloat(av.replace(/[,，\s¥%]/g, ""));
      var bn = parseFloat(bv.replace(/[,，\s¥%]/g, ""));
      var r = (!isNaN(an) && !isNaN(bn)) ? an - bn : av.localeCompare(bv, "zh");
      return desc ? -r : r;
    });
    rows.forEach(function (r) { tbody.appendChild(r); });
    rows.forEach(activateIn);
  });
  DOC.addEventListener("change", function (e) {
    var all = e.target.closest("[data-select-all]");
    if (all) {
      var table = all.closest("table");
      $$("tbody input[type=checkbox]", table).forEach(function (c) { c.checked = all.checked; });
      $$("tbody tr", table).forEach(function (tr) { tr.classList.toggle("is-selected", all.checked); });
      return;
    }
    if (e.target.matches("tbody input[type=checkbox]")) {
      e.target.closest("tr").classList.toggle("is-selected", e.target.checked);
    }
  });

  /* ------------------------------------------------------ 12. 数字滚动 / 进度 / 倒计时 / 骨架 */
  function animateCount(el) {
    if (el.__counted) return;
    el.__counted = true;
    var target = parseFloat(el.getAttribute("data-count-to")) || 0;
    var dec = parseInt(el.getAttribute("data-decimals"), 10) || 0;
    var pre = el.getAttribute("data-prefix") || "";
    var suf = el.getAttribute("data-suffix") || "";
    var dur = parseInt(el.getAttribute("data-count-dur"), 10) || 900;
    var start = null;
    function frame(ts) {
      if (!start) start = ts;
      var p = Math.min(1, (ts - start) / dur);
      var eased = 1 - Math.pow(1 - p, 3);
      var val = target * eased;
      el.textContent = pre + val.toFixed(dec).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + suf;
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }
  function activateIn(root) {
    if (!root) return;
    var self = root.classList && root.classList.contains("reveal") ? [root] : [];
    $$(".reveal:not(.in)", root).forEach(function (el) {
      io.observe(el);
    });
    self.forEach(function (el) { io.observe(el); });
    $$("[data-count-to]", root).forEach(function (el) {
      if (el.closest(".page") && !el.closest(".page").classList.contains("is-active")) return;
      animateCount(el);
    });
    $$("[data-progress]", root).forEach(function (el) {
      var bar = el.classList.contains("progress-bar") ? el : $(".progress-bar", el);
      if (bar) bar.style.width = el.getAttribute("data-progress") + "%";
    });
  }
  var io = ("IntersectionObserver" in window) ? new IntersectionObserver(function (entries) {
    entries.forEach(function (en) {
      if (en.isIntersecting) {
        en.target.classList.add("in");
        io.unobserve(en.target);
      }
    });
  }, { threshold: .12 }) : null;

  $$("[data-countdown]").forEach(function (el) {
    var left = parseInt(el.getAttribute("data-countdown"), 10) || 0;
    function pad(n) { return n < 10 ? "0" + n : "" + n; }
    function tick() {
      var h = Math.floor(left / 3600), m = Math.floor(left % 3600 / 60), s = left % 60;
      var H = $(".cd-h", el), M = $(".cd-m", el), S = $(".cd-s", el);
      if (H) H.textContent = pad(h);
      if (M) M.textContent = pad(m);
      if (S) S.textContent = pad(s);
      if (left <= 0) { el.classList.add("is-end"); return; }
      left--;
      setTimeout(tick, 1000);
    }
    tick();
  });

  DOC.addEventListener("click", function (e) {
    var sk = e.target.closest("[data-skeleton]");
    if (!sk) return;
    var target = overlayOf(sk.getAttribute("data-skeleton"));
    if (!target) return;
    if (target.__skBusy) return;
    target.__skBusy = true;
    var ov = DOC.createElement("div");
    ov.className = "spinner-center";
    ov.innerHTML = '<span class="spinner"></span>';
    target.appendChild(ov);
    setTimeout(function () {
      ov.remove();
      target.__skBusy = false;
      toast("数据加载完成", "success");
    }, parseInt(sk.getAttribute("data-skeleton-ms"), 10) || 1500);
  });

  /* ------------------------------------------------------ 13. 杂项交互 */
  DOC.addEventListener("click", function (e) {
    var fav = e.target.closest("[data-fav]");
    if (fav) {
      fav.classList.toggle("is-on");
      return;
    }
    var sb = e.target.closest("[data-sidebar-toggle]");
    if (sb) {
      var side = $(".sidebar", app);
      if (side) side.classList.toggle("open");
      return;
    }
    var nav = e.target.closest(".nav-item[data-sub]");
    if (nav) {
      nav.classList.toggle("open");
      return;
    }
    var chk = e.target.closest(".list-item[data-checkable], .cell[data-checkable]");
    if (chk) chk.classList.toggle("is-active");
  });

  /* ------------------------------------------------------ 启动 */
  function boot() {
    injectIcons(DOC);
    initTabs();
    initSeg();
    var first = $(".page.is-active") || $(".page");
    if (first && !first.classList.contains("is-active")) first.classList.add("is-active");
    if (first) {
      setIndicator(first);
      setTimeout(function () { activateIn(first); }, 60);
    }
    window.addEventListener("resize", function () {
      initTabs();
      initSeg();
    });
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(function () { initTabs(); initSeg(); });
    }
  }
  if (DOC.readyState === "loading") {
    DOC.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();

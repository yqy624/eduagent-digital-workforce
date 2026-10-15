/* hifi-bridge.js —— 让动态渲染的内容也能用上 hifi 组件库
 *
 * hifi.js 只在页面加载时扫描一次 DOM（图标注入 / 进度条 / 数字滚动），
 * 而本平台的内容是 JS 按需渲染的。本文件为动态节点补上这三件事。
 * 图标路径与 hifi.js 的 ICONS 表一致（由脚本从 hifi.js 提取生成）。
 */
(function () {
  "use strict";
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

  function injectIcons(root) {
    var nodes = (root || document).querySelectorAll("[data-icon]");
    Array.prototype.forEach.call(nodes, function (el) {
      if (el.__iconDone) return;
      el.__iconDone = true;
      var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("viewBox", "0 0 24 24");
      svg.setAttribute("aria-hidden", "true");
      svg.innerHTML = ICONS[el.getAttribute("data-icon")] || ICONS.info;
      el.appendChild(svg);
    });
  }

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
      var val = target * (1 - Math.pow(1 - p, 3));
      el.textContent = pre + val.toFixed(dec).replace(/\B(?=(\d{3})+(?!\d))/g, ",") + suf;
      if (p < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  /* 分段控件：hifi.js 只在 boot 时绑定一次，动态渲染的这里补上 */
  function bindSeg(root) {
    Array.prototype.forEach.call((root || document).querySelectorAll("[data-seg]"), function (box) {
      var row = box.querySelector(".seg");
      if (!row || row.__segBound) return;
      row.__segBound = true;
      var items = row.querySelectorAll(".seg-item");
      if (!items.length) return;
      var thumb = row.querySelector(".seg-thumb");
      if (!thumb) {
        thumb = document.createElement("span");
        thumb.className = "seg-thumb";
        row.insertBefore(thumb, items[0]);
      }
      function place(on) {
        if (!on) return;
        thumb.style.width = on.offsetWidth + "px";
        thumb.style.transform = "translateX(" + (on.offsetLeft - 3) + "px)";
      }
      function show(key) {
        Array.prototype.forEach.call(box.querySelectorAll("[data-seg-view]"), function (v) {
          v.hidden = v.getAttribute("data-seg-view") !== key;
        });
      }
      row.addEventListener("click", function (e) {
        var it = e.target.closest(".seg-item");
        if (!it) return;
        Array.prototype.forEach.call(items, function (x) { x.classList.toggle("is-on", x === it); });
        place(it);
        show(it.getAttribute("data-seg-panel"));
      });
      var on = row.querySelector(".seg-item.is-on") || items[0];
      on.classList.add("is-on");
      place(on);
      show(on.getAttribute("data-seg-panel"));
    });
  }

  function mount(root) {
    if (!root) return;
    injectIcons(root);
    bindSeg(root);
    Array.prototype.forEach.call(root.querySelectorAll("[data-count-to]"), animateCount);
    Array.prototype.forEach.call(root.querySelectorAll("[data-progress]"), function (el) {
      var bar = el.classList.contains("progress-bar") ? el : el.querySelector(".progress-bar");
      if (bar) bar.style.width = el.getAttribute("data-progress") + "%";
    });
    Array.prototype.forEach.call(root.querySelectorAll(".reveal"), function (el) {
      if (!el.classList.contains("in")) requestAnimationFrame(function () { el.classList.add("in"); });
    });
  }

  window.Hifi = { mount: mount, icons: ICONS };
})();

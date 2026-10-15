/**
 * 内联 SVG 图标集。
 *
 * 不引入任何图标 CDN：平台可能部署在无外网的校内环境，
 * 外部字体/图标包会直接导致界面破相。全部图标为 24×24 线框，
 * 1.7px 描边，几何图元手工给出，便于校对。
 *
 * 用法：icon("scan", "ic") → "<svg class='ic' …><use href='#i-scan'/></svg>"
 * 首次调用时把 sprite 注入 <body> 末尾。
 */

const P = {
  // —— 感知 ——
  "scan":
    '<path d="M3 7.5V5.5A2.5 2.5 0 0 1 5.5 3h2M16.5 3h2A2.5 2.5 0 0 1 21 5.5v2M21 16.5v2A2.5 2.5 0 0 1 18.5 21h-2M7.5 21h-2A2.5 2.5 0 0 1 3 18.5v-2"/>' +
    '<circle cx="12" cy="12" r="3.2"/><path d="M12 5.6v2M12 16.4v2M5.6 12h2M16.4 12h2"/>',
  "target": '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>',
  "crosshair": '<circle cx="12" cy="12" r="8.5"/><path d="M12 2.5v6M12 15.5v6M2.5 12h6M15.5 12h6"/>',
  "eye": '<path d="M2.2 12S6 5.4 12 5.4 21.8 12 21.8 12 18 18.6 12 18.6 2.2 12 2.2 12Z"/><circle cx="12" cy="12" r="3"/>',
  "eye-off": '<path d="M4 4l16 16"/><path d="M9.9 5.8A9.7 9.7 0 0 1 12 5.5c6 0 9.8 6.5 9.8 6.5a17 17 0 0 1-3.3 4M6.4 7.9A16.6 16.6 0 0 0 2.2 12S6 18.5 12 18.5a9.6 9.6 0 0 0 3.6-.7"/><path d="M9.8 9.9a3 3 0 0 0 4.3 4.2"/>',
  "camera": '<path d="M3 8.5A2.5 2.5 0 0 1 5.5 6h1.9l1.2-2h6.8l1.2 2h1.9A2.5 2.5 0 0 1 21 8.5v9A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5Z"/><circle cx="12" cy="13" r="3.6"/>',
  "video": '<rect x="2.6" y="6" width="13" height="12" rx="2.4"/><path d="M15.6 11.2l5.4-3.1v7.8l-5.4-3.1Z"/>',
  "broadcast": '<circle cx="12" cy="12" r="2.4"/><path d="M7.5 7.5a6.4 6.4 0 0 0 0 9M16.5 16.5a6.4 6.4 0 0 0 0-9"/><path d="M4.7 4.7a10.3 10.3 0 0 0 0 14.6M19.3 19.3a10.3 10.3 0 0 0 0-14.6"/>',
  "activity": '<path d="M2.5 12h4l2.5-7 4 14 2.5-7h6"/>',
  "gauge": '<path d="M4 18a9 9 0 1 1 16 0"/><path d="M12 14.5l4-4"/><circle cx="12" cy="15" r="1.3"/>',
  "cpu": '<rect x="7" y="7" width="10" height="10" rx="2"/><rect x="10" y="10" width="4" height="4" rx="1"/><path d="M10 2.6v3.4M14 2.6v3.4M10 18v3.4M14 18v3.4M2.6 10H6M2.6 14H6M18 10h3.4M18 14h3.4"/>',
  "database": '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6"/><path d="M4.5 12c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3"/>',
  "server": '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01"/>',
  "wifi": '<path d="M2.5 9.5a14 14 0 0 1 19 0M6 13a9 9 0 0 1 12 0M9.4 16.4a4.2 4.2 0 0 1 5.2 0"/><circle cx="12" cy="19.6" r="1"/>',
  // —— 模块 ——
  "pen": '<path d="M14.5 5.2l4.3 4.3M4 20l4-.8L19.6 7.6a2.1 2.1 0 0 0 0-3l-1.2-1.2a2.1 2.1 0 0 0-3 0L3.8 16Z"/><path d="M3.8 16l4 4"/>',
  "chart": '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  "wand": '<path d="M14 6l4 4M4 20l9.5-9.5M17 3l1 2 2 1-2 1-1 2-1-2-2-1 2-1ZM6 4l.7 1.4L8 6l-1.3.6L6 8l-.7-1.4L4 6l1.3-.6Z"/>',
  "sliders": '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  "shield": '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.4-7.5 9.5-4.3-1.1-7.5-4.9-7.5-9.5V6Z"/>',
  "shield-check": '<path d="M12 3l7.5 3v5.5c0 4.6-3.2 8.4-7.5 9.5-4.3-1.1-7.5-4.9-7.5-9.5V6Z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  "school": '<path d="M12 3l9 5H3ZM5 8v10M19 8v10M9 8v10M15 8v10M3 21h18"/>',
  "flask": '<path d="M9 3h6M10 3v6.2L5.2 17a3 3 0 0 0 2.6 4.5h8.4A3 3 0 0 0 18.8 17L14 9.2V3"/><path d="M7.6 14h8.8"/>',
  "bot": '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V4.5M9 4.5h6"/><circle cx="9" cy="13.5" r="1.3"/><circle cx="15" cy="13.5" r="1.3"/><path d="M2.5 12v3M21.5 12v3"/>',
  "sparkles": '<path d="M12 3l1.6 4.4L18 9l-4.4 1.6L12 15l-1.6-4.4L6 9l4.4-1.6ZM18.5 15l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8Z"/>',
  "book": '<path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5Z"/><path d="M4 20.5A2.5 2.5 0 0 1 6.5 18H20v3H6.5"/>',
  "file": '<path d="M13.5 3H7a2.5 2.5 0 0 0-2.5 2.5v13A2.5 2.5 0 0 0 7 21h10a2.5 2.5 0 0 0 2.5-2.5V9Z"/><path d="M13.5 3v6h6"/>',
  "file-text": '<path d="M13.5 3H7a2.5 2.5 0 0 0-2.5 2.5v13A2.5 2.5 0 0 0 7 21h10a2.5 2.5 0 0 0 2.5-2.5V9Z"/><path d="M13.5 3v6h6M8.5 13h7M8.5 16.5h4.5"/>',
  "folder": '<path d="M3 7a2.5 2.5 0 0 1 2.5-2.5h3.2L11 7h7.5A2.5 2.5 0 0 1 21 9.5v8A2.5 2.5 0 0 1 18.5 20h-13A2.5 2.5 0 0 1 3 17.5Z"/>',
  "box": '<path d="M12 2.8l8.5 4.7v9L12 21.2 3.5 16.5v-9Z"/><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9.2"/>',
  "layers": '<path d="M12 3l9 4.6-9 4.6-9-4.6Z"/><path d="M3.2 12.4L12 17l8.8-4.6M3.2 16.6L12 21.2l8.8-4.6"/>',
  "clipboard": '<rect x="5" y="4.5" width="14" height="16" rx="2.4"/><path d="M9 4.5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2"/><path d="M9 11h6M9 15h4"/>',
  "table": '<rect x="3" y="4.5" width="18" height="15" rx="2.4"/><path d="M3 9.5h18M9 9.5v10M15 9.5v10"/>',
  "list": '<path d="M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01"/>',
  "grid": '<rect x="3.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.6"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.6"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.6"/>',
  "hash": '<path d="M5 9h14M5 15h14M10 3.5L8 20.5M16 3.5l-2 17"/>',
  "trend": '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/>',
  "pie": '<path d="M12 3a9 9 0 1 0 9 9h-9Z"/><path d="M12 3v9h9A9 9 0 0 0 12 3Z"/>',
  // —— 操作 ——
  "search": '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/>',
  "menu": '<path d="M3.5 6.5h17M3.5 12h17M3.5 17.5h17"/>',
  "x": '<path d="M6 6l12 12M18 6L6 18"/>',
  "check": '<path d="M4.5 12.5l5 5 10-11"/>',
  "check-circle": '<circle cx="12" cy="12" r="9"/><path d="M8 12.2l2.6 2.6L16 9.2"/>',
  "check-square": '<rect x="3.5" y="3.5" width="17" height="17" rx="3"/><path d="M8 12.3l2.6 2.6L16.2 9.5"/>',
  "circle": '<circle cx="12" cy="12" r="8.5"/>',
  "alert": '<path d="M12 4.2l8.6 15H3.4Z"/><path d="M12 10v4.2M12 17.2h.01"/>',
  "x-circle": '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  "info": '<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.8h.01"/>',
  "clock": '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.4l3.4 2"/>',
  "refresh": '<path d="M20 11a8 8 0 1 0-2.3 6.1"/><path d="M20 4.5V11h-6.5"/>',
  "play": '<path d="M7 4.8l12 7.2-12 7.2Z"/>',
  "pause": '<path d="M8.5 5v14M15.5 5v14"/>',
  "zap": '<path d="M13.5 2.5L4 13.6h6.5L10.5 21.5 20 10.4h-6.5Z"/>',
  "plus": '<path d="M12 5v14M5 12h14"/>',
  "minus": '<path d="M5 12h14"/>',
  "trash": '<path d="M4 7h16M9 7V4.8A1.3 1.3 0 0 1 10.3 3.5h3.4A1.3 1.3 0 0 1 15 4.8V7"/><path d="M6.5 7l1 12.2A1.8 1.8 0 0 0 9.3 21h5.4a1.8 1.8 0 0 0 1.8-1.8L17.5 7"/>',
  "edit": '<path d="M4 20h4L19.5 8.5a2.1 2.1 0 0 0-3-3L5 17v3Z"/><path d="M14.5 5.5l3 3"/>',
  "copy": '<rect x="8.5" y="8.5" width="12" height="12" rx="2.4"/><path d="M15.5 8.5V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h2.5"/>',
  "upload": '<path d="M12 16V4.5M7.5 9L12 4.5 16.5 9"/><path d="M4 15.5V18a2.5 2.5 0 0 0 2.5 2.5h11A2.5 2.5 0 0 0 20 18v-2.5"/>',
  "download": '<path d="M12 4.5V16M7.5 11.5L12 16l4.5-4.5"/><path d="M4 15.5V18a2.5 2.5 0 0 0 2.5 2.5h11A2.5 2.5 0 0 0 20 18v-2.5"/>',
  "filter": '<path d="M3.5 5h17l-6.6 7.8V19l-3.8 2v-8.2Z"/>',
  "sort": '<path d="M8 4v16M5 17l3 3 3-3M16 20V4M13 7l3-3 3 3"/>',
  "more": '<circle cx="5.5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18.5" cy="12" r="1.6"/>',
  "external": '<path d="M14 4h6v6M20 4l-8.5 8.5"/><path d="M18 14v4.5A2.5 2.5 0 0 1 15.5 21H6a2.5 2.5 0 0 1-2.5-2.5V9A2.5 2.5 0 0 1 6 6.5h4.5"/>',
  "ban": '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
  "undo": '<path d="M4 9h10.5a5 5 0 0 1 0 10H8"/><path d="M4 9l4-4M4 9l4 4"/>',
  "key": '<circle cx="8" cy="14" r="4.5"/><path d="M11.5 11.5L20 3M17 4.5l3 3M15 6.5l2.5 2.5"/>',
  "command": '<path d="M8.5 3A2.5 2.5 0 1 0 8.5 8h7A2.5 2.5 0 1 0 18 3a2.5 2.5 0 0 0-2.5 2.5v7A2.5 2.5 0 1 0 18 15a2.5 2.5 0 0 0-2.5-2.5h-7A2.5 2.5 0 1 0 6 15a2.5 2.5 0 0 0 2.5-2.5v-7"/>',
  "log-in": '<path d="M14 4h3.5A2.5 2.5 0 0 1 20 6.5v11a2.5 2.5 0 0 1-2.5 2.5H14"/><path d="M9 8l4 4-4 4M13 12H3"/>',
  "log-out": '<path d="M10 4H6.5A2.5 2.5 0 0 0 4 6.5v11A2.5 2.5 0 0 0 6.5 20H10"/><path d="M15 8l4 4-4 4M19 12H9"/>',
  "user": '<circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/>',
  "users": '<circle cx="9" cy="8" r="3.6"/><path d="M2.6 20a6.6 6.6 0 0 1 12.8 0"/><path d="M16.5 5.2a3.6 3.6 0 0 1 0 6.6M18 14.4a6.6 6.6 0 0 1 3.4 5.6"/>',
  "user-check": '<circle cx="9.5" cy="8" r="4"/><path d="M2.5 20.5a7.5 7.5 0 0 1 13.2-4.9"/><path d="M16 16.5l2 2 4-4.2"/>',
  "mail": '<rect x="2.8" y="5" width="18.4" height="14" rx="2.4"/><path d="M3.5 7l8.5 6 8.5-6"/>',
  "lock": '<rect x="4.5" y="10.5" width="15" height="10" rx="2.4"/><path d="M8 10.5V7.8a4 4 0 0 1 8 0v2.7"/><path d="M12 14.5v2.5"/>',
  "hash-sm": '<path d="M6 9h12M6 15h12M10 4l-1.6 16M15.6 4L14 20"/>',
  "calendar": '<rect x="3.5" y="5" width="17" height="15.5" rx="2.4"/><path d="M3.5 10h17M8 3.5v3M16 3.5v3"/>',
  "star": '<path d="M12 3.5l2.7 5.6 6.1.8-4.5 4.2 1.1 6-5.4-3-5.4 3 1.1-6L3.2 9.9l6.1-.8Z"/>',
  "bookmark": '<path d="M6.5 3.5h11a1.5 1.5 0 0 1 1.5 1.5v15.5L12 16.4 5 20.5V5a1.5 1.5 0 0 1 1.5-1.5Z"/>',
  "flag": '<path d="M5 21V4M5 4.5h12l-1.8 4 1.8 4H5"/>',
  "code": '<path d="M9 7l-5 5 5 5M15 7l5 5-5 5"/>',
  "terminal": '<rect x="3" y="4.5" width="18" height="15" rx="2.4"/><path d="M7.5 10l2.5 2.5-2.5 2.5M12.5 15h4"/>',
  "image": '<rect x="3" y="4.5" width="18" height="15" rx="2.4"/><circle cx="8.6" cy="9.6" r="1.7"/><path d="M4 17l4.8-4.8 3.7 3.7 3-3L20 16.6"/>',
  "arrow-up": '<path d="M12 20V4M6 10l6-6 6 6"/>',
  "send": '<path d="M21.4 2.6 2.6 9.6l7.2 2.9 2.9 7.2 8.7-17.1Z"/><path d="M9.8 12.5 21.4 2.6"/>',
  "arrow-right": '<path d="M4 12h16M14 6l6 6-6 6"/>',
  "arrow-left": '<path d="M20 12H4M10 6l-6 6 6 6"/>',
  "chevron-right": '<path d="M9 5.5l6.5 6.5L9 18.5"/>',
  "chevron-down": '<path d="M5.5 9L12 15.5 18.5 9"/>',
  "chevron-left": '<path d="M15 5.5L8.5 12 15 18.5"/>',
  "chevron-up": '<path d="M5.5 15L12 8.5 18.5 15"/>',
  "corner-down": '<path d="M5 4v9a3 3 0 0 0 3 3h11"/><path d="M16 13l3 3-3 3"/>',
  "pointer": '<path d="M5 3l14 8-6 1.6L10.4 19Z"/>',
  "cross": '<path d="M12 4v16M4 12h16"/>',
  "dot": '<circle cx="12" cy="12" r="4.5"/>',
  "school-outline": '<path d="M12 3l9 5H3ZM5 8v10M19 8v10M3 21h18"/>',
  "monitor": '<rect x="2.6" y="4" width="18.8" height="12.5" rx="2.4"/><path d="M8.5 20.5h7M12 16.5v4"/>',
  "alert-octagon": '<path d="M8.6 3h6.8L21 8.6v6.8L15.4 21H8.6L3 15.4V8.6Z"/><path d="M12 8v4.5M12 16h.01"/>'
};

const SPRITE = '<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">' +
  Object.keys(P).map(function (k) {
    return '<symbol id="i-' + k + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
      'stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + P[k] + "</symbol>";
  }).join("") + "</svg>";

let injected = false;
function injectSprite() {
  if (injected || typeof document === "undefined") return;
  const host = document.createElement("div");
  host.setAttribute("data-svg-sprite", "");
  host.innerHTML = SPRITE;
  document.body.appendChild(host);
  injected = true;
}

/** icon("scan", "ic") → SVG 字符串。未知名称回退到 i-dot，不抛错。 */
export function icon(name, cls) {
  injectSprite();
  const id = P[name] ? name : "dot";
  return '<svg class="' + (cls || "ic") + '" aria-hidden="true"><use href="#i-' + id + '"/></svg>';
}

export const ICON_NAMES = Object.keys(P);

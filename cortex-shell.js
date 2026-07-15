/* =====================================================================
   cortex-shell.js — shared chrome for every CORTEX OS page. (v2 — teal)
   Injects the top navigation (categorized dropdowns on desktop,
   hamburger drawer on mobile, role-aware links) and carries its own
   styles, so individual pages never hand-copy nav markup or CSS.

   USAGE: add ONE line near the end of each page's <body>:
     <script src="/cortex-shell.js" defer></script>

   ADD A PAGE: edit the NAV array below — once — and every page
   picks it up automatically.

   ACCESS (Cortex Identity): the shell asks /api/budget-events?mode=perms
   once and gates every link by capability:
     - Each NAV link/category declares cap: "<capability>".
     - A user sees a link if their capabilities include it, or "*".
     - Manage access in BigQuery (identity.users / identity.roles) —
       no shell changes or deploys needed.

   BRAND (teal identity):
     --brand-bg      #0d0d12  (dark carbon — header/drawer/panels)
     --brand-bg-nav  #14141b  (nav strip, one notch lighter)
     --brand-teal    #00D4AA  (accent — active/hover)
   ===================================================================== */
(function () {
  "use strict";

  // ---- Ticket bot (n8n hosted chat widget) ----
  var BOT_WEBHOOK_URL = "https://naterimc.app.n8n.cloud/webhook/80464afc-47e2-4cd9-9164-1f2a9aac272e/chat";
  var BOT_CSS_URL     = "https://cdn.jsdelivr.net/npm/@n8n/chat/dist/style.css";
  var BOT_JS_URL      = "https://cdn.jsdelivr.net/npm/@n8n/chat/dist/chat.bundle.es.js";

  // ---- Single source of truth for the nav. ----
  // Top-level items can be direct links {label, href, cap?} or categories
  // {label, items:[{label, href, cap?}]}. cap = capability required to
  // see the link (from identity.user_access). No cap = visible to all.
  var NAV = [
    { label: "Home", href: "index.html" },
    {
      label: "Performance",
      items: [
        { label: "Ad Spend Pacing", href: "ad-spend-pacing.html", cap: "performance.view" },
        { label: "Campaign Triage", href: "triage.html",          cap: "performance.view" },
        { label: "Call Tracking",   href: "call-tracking.html",   cap: "performance.view" }
      ]
    },
    {
      label: "Budgets",
      items: [
        { label: "Budget Planning", href: "budget-planning.html", cap: "budgets.view" },
        { label: "Budget History",  href: "budget-history.html",  cap: "budgets.history" }
      ]
    },
    {
      label: "Ops",
      items: [
        { label: "Tickets",          href: "tickets.html",          cap: "tickets.use" },
        { label: "Roadmap",          href: "roadmap.html",          cap: "roadmap.view" },
        { label: "Strategy",         href: "strategy.html",         cap: "strategy.view" },
        { label: "KPI Criteria",     href: "kpi.html",              cap: "kpi.view" },
        { label: "Account Standard", href: "account-standard.html", cap: "accounts.view" }
      ]
    },
    {
      label: "Admin",
      items: [
        { label: "Identity", href: "identity.html", cap: "admin.users" }
      ]
    }
  ];

  // First render happens before perms arrive; assume the baseline package
  // every current role has, so the nav doesn't flash empty. Sensitive links
  // (budgets.history) stay hidden until real capabilities confirm them.
  var DEFAULT_CAPS = [
    "performance.view", "budgets.view", "tickets.use",
    "roadmap.view", "strategy.view", "kpi.view", "accounts.view"
  ];

  // ---- Styles ----
  var CSS = '' +
    '.site-top{position:sticky;top:0;z-index:100;}' +
    '.site-header{background:#0d0d12;padding:0 32px;height:52px;display:flex;align-items:center;justify-content:space-between;box-shadow:0 1px 0 rgba(255,255,255,.06);}' +
    '.brand{display:flex;align-items:center;gap:10px;text-decoration:none;}' +
    '.brand-mark{width:22px;height:22px;flex:0 0 auto;}' +
    '.brand-name{font-size:17px;font-weight:700;color:#fff;letter-spacing:-.3px;}' +
    '.brand-divider{color:rgba(255,255,255,.25);font-size:14px;}' +
    '.brand-sub{font-size:11px;color:rgba(255,255,255,.45);font-weight:500;}' +

    /* ---- Desktop nav ---- */
    '.site-nav{background:#14141b;padding:0 32px;display:flex;gap:2px;border-bottom:1px solid rgba(255,255,255,.07);}' +
    '.nav-link{color:rgba(255,255,255,.5);text-decoration:none;font-size:13px;font-weight:500;padding:11px 16px;border-bottom:2px solid transparent;transition:color .18s,border-color .18s;display:inline-flex;align-items:center;gap:6px;background:none !important;border-top:0;border-left:0;border-right:0;font-family:inherit;cursor:pointer;outline:none;}' +
    '.nav-link:hover,.nav-link:focus,.nav-link:focus-visible{color:#fff;background:none !important;}' +
    '.nav-link.active{color:#fff;border-bottom-color:#00D4AA;background:none !important;}' +
    '.nav-dd.open>.dd-toggle,.nav-dd:hover>.dd-toggle{color:#fff;background:none !important;}' +
    '.nav-dd{position:relative;}' +
    '.nav-dd .chev{width:8px;height:8px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg) translateY(-2px);transition:transform .2s;margin-left:2px;}' +
    '.nav-dd.open .chev,.nav-dd:hover .chev{transform:rotate(225deg) translateY(2px);}' +
    '.dd-panel{position:absolute;top:calc(100% + 1px);left:8px;min-width:200px;background:#0d0d12;border:1px solid rgba(255,255,255,.09);border-radius:0 0 10px 10px;box-shadow:0 14px 34px rgba(0,0,0,.5);padding:6px;opacity:0;transform:translateY(8px);pointer-events:none;transition:opacity .18s ease,transform .18s ease;}' +
    '.nav-dd.open .dd-panel,.nav-dd:hover .dd-panel{opacity:1;transform:translateY(0);pointer-events:auto;}' +
    '.dd-item{display:block;padding:9px 12px;border-radius:7px;color:rgba(255,255,255,.6);text-decoration:none;font-size:13px;font-weight:500;transition:background .14s,color .14s,padding-left .14s;}' +
    '.dd-item:hover{background:rgba(0,212,170,.14);color:#fff;padding-left:16px;}' +
    '.dd-item.active{color:#fff;background:rgba(0,212,170,.22);}' +

    /* ---- Hamburger (hidden on desktop) ---- */
    '.nav-burger{display:none;background:none;border:0;cursor:pointer;padding:10px;margin-right:-10px;}' +
    '.nav-burger span{display:block;width:22px;height:2px;background:#fff;margin:5px 0;border-radius:2px;transition:transform .25s,opacity .2s;}' +
    '.nav-burger.open span:nth-child(1){transform:translateY(7px) rotate(45deg);}' +
    '.nav-burger.open span:nth-child(2){opacity:0;}' +
    '.nav-burger.open span:nth-child(3){transform:translateY(-7px) rotate(-45deg);}' +

    /* ---- Mobile drawer ---- */
    '.nav-backdrop{position:fixed;inset:0;background:rgba(4,4,8,.6);opacity:0;pointer-events:none;transition:opacity .25s;z-index:998;}' +
    '.nav-backdrop.open{opacity:1;pointer-events:auto;}' +
    '.nav-drawer{position:fixed;top:0;left:0;bottom:0;width:282px;max-width:82vw;background:#0d0d12;z-index:999;transform:translateX(-102%);transition:transform .27s cubic-bezier(.3,.8,.3,1);display:flex;flex-direction:column;box-shadow:8px 0 32px rgba(0,0,0,.5);}' +
    '.nav-drawer.open{transform:translateX(0);}' +
    '.drawer-head{padding:18px 20px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;gap:9px;}' +
    '.drawer-head .brand-name{font-size:16px;}' +
    '.drawer-head .brand-mark{width:20px;height:20px;}' +
    '.drawer-body{overflow-y:auto;padding:10px 12px 24px;flex:1;}' +
    '.drawer-link{display:block;padding:12px 12px;color:rgba(255,255,255,.65);text-decoration:none;font-size:14px;font-weight:500;border-radius:8px;transition:background .14s,color .14s;}' +
    '.drawer-link:hover{background:rgba(255,255,255,.06);color:#fff;}' +
    '.drawer-link.active{background:rgba(0,212,170,.2);color:#fff;}' +
    '.drawer-cat{margin-top:6px;}' +
    '.drawer-cat-btn{width:100%;display:flex;align-items:center;justify-content:space-between;background:none;border:0;cursor:pointer;padding:12px 12px;color:rgba(255,255,255,.85);font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.7px;font-family:inherit;border-radius:8px;transition:background .14s;}' +
    '.drawer-cat-btn:hover{background:rgba(255,255,255,.05);}' +
    '.drawer-cat-btn .chev{width:8px;height:8px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:rotate(45deg);transition:transform .22s;}' +
    '.drawer-cat.open .drawer-cat-btn .chev{transform:rotate(225deg);}' +
    '.drawer-cat-items{max-height:0;overflow:hidden;transition:max-height .28s ease;padding-left:8px;}' +
    '.drawer-cat.open .drawer-cat-items{max-height:320px;}' +

    '@media (max-width: 768px){' +
      '.site-nav{display:none;}' +
      '.nav-burger{display:block;}' +
      '.site-header{padding:0 20px;}' +
    '}' +

    /* ---- n8n chat widget: bottom-LEFT position + Cortex teal, direct class targeting ---- */
    /* Position (widget uses .chat-window-wrapper / .chat-window) */
    '.n8n-chat.chat-window-wrapper,.n8n-chat .chat-window-toggle{right:auto !important;left:20px !important;}' +
    '.n8n-chat .chat-window{right:auto !important;left:20px !important;bottom:90px !important;' +
      'width:380px !important;height:560px !important;' +
      'border-radius:18px !important;overflow:hidden !important;' +
      'box-shadow:0 18px 50px rgba(0,0,0,.4) !important;border:1px solid rgba(255,255,255,.08) !important;}' +
    /* Header -> carbon */
    '.n8n-chat .chat-header,.n8n-chat .chat-heading{background:#0d0d12 !important;}' +
    '.n8n-chat .chat-header *,.n8n-chat .chat-heading *{color:#fff !important;}' +
    /* Toggle bubble -> teal, rounded, ticket icon */
    '.n8n-chat .chat-window-toggle{background:#00D4AA !important;border-radius:16px !important;box-shadow:0 6px 20px rgba(0,212,170,.4) !important;}' +
    '.n8n-chat .chat-window-toggle:hover{background:#00c39c !important;}' +
    '.n8n-chat .chat-window-toggle > *{display:none !important;}' +
    '.n8n-chat .chat-window-toggle::after{' +
      'content:"";display:block;' +
      'width:26px;height:26px;' +
      'background-color:#0d0d12;' +
      "-webkit-mask:url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"black\"><path d=\"M22 10V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v4a2 2 0 0 1 0 4v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 1 0-4zM13 5.5h-2v2h2zm0 5h-2v3h2zm0 6h-2v2h2z\"/></svg>') center/contain no-repeat;" +
      "mask:url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"black\"><path d=\"M22 10V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v4a2 2 0 0 1 0 4v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 1 0-4zM13 5.5h-2v2h2zm0 5h-2v3h2zm0 6h-2v2h2z\"/></svg>') center/contain no-repeat;" +
    '}' +
    /* Send button + user message bubbles -> teal */
    '.n8n-chat .chat-input .chat-input-send-button,.n8n-chat [class*="send"]{color:#00D4AA !important;}' +
    '.n8n-chat .chat-message-from-user .chat-message-markdown{background:#00D4AA !important;color:#0d0d12 !important;}';

  // ---- Brand mark (inline SVG: teal C + chevron) ----
  var MARK = '<svg class="brand-mark" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
    '<path d="M23 9.5a9 9 0 1 0 0 13" stroke="#00D4AA" stroke-width="3.2" stroke-linecap="round"/>' +
    '<circle cx="24.5" cy="16" r="2.4" fill="#00D4AA"/>' +
    '</svg>';

  // ---- Permissions (capability-aware links) ----
  var PERMS = { role: null, capabilities: DEFAULT_CAPS, loaded: false };

  function fetchPerms() {
    return fetch("/api/budget-events?mode=perms", { cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (p) {
        if (p) {
          PERMS.role = p.role || null;
          PERMS.capabilities = Array.isArray(p.capabilities) ? p.capabilities : [];
        }
        PERMS.loaded = true;
      })
      .catch(function () { PERMS.loaded = true; });
  }

  function hasCap(cap) {
    var caps = PERMS.capabilities || [];
    return caps.indexOf("*") !== -1 || caps.indexOf(cap) !== -1;
  }
  function linkVisible(link) {
    if (link.cap && !hasCap(link.cap)) return false;
    return true;
  }
  function categoryVisible(cat) {
    return cat.items.some(linkVisible);
  }

  // ---- Active-page helpers ----
  function currentFile() {
    var path = window.location.pathname;
    var last = path.substring(path.lastIndexOf("/") + 1);
    if (last === "") return "index.html";
    return last;
  }
  function isActive(href) {
    var hrefBase = href.replace(/\.html$/, "");
    var curBase = currentFile().replace(/\.html$/, "");
    return hrefBase === curBase;
  }
  function categoryActive(cat) {
    return cat.items.some(function (l) { return isActive(l.href); });
  }

  // ---- Build desktop nav + mobile drawer ----
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function buildDesktopNav() {
    var html = "";
    NAV.forEach(function (item) {
      if (item.href) {
        html += '<a href="' + item.href + '" class="nav-link' + (isActive(item.href) ? " active" : "") + '">' + esc(item.label) + "</a>";
        return;
      }
      if (!categoryVisible(item)) return;
      var links = item.items.filter(linkVisible).map(function (l) {
        return '<a href="' + l.href + '" class="dd-item' + (isActive(l.href) ? " active" : "") + '">' + esc(l.label) + "</a>";
      }).join("");
      html +=
        '<div class="nav-dd' + (categoryActive(item) ? " is-current" : "") + '">' +
          '<button type="button" class="nav-link dd-toggle' + (categoryActive(item) ? " active" : "") + '" aria-haspopup="true" aria-expanded="false">' +
            esc(item.label) + '<span class="chev"></span>' +
          "</button>" +
          '<div class="dd-panel">' + links + "</div>" +
        "</div>";
    });
    return html;
  }

  function buildDrawer() {
    var html = "";
    NAV.forEach(function (item) {
      if (item.href) {
        html += '<a href="' + item.href + '" class="drawer-link' + (isActive(item.href) ? " active" : "") + '">' + esc(item.label) + "</a>";
        return;
      }
      if (!categoryVisible(item)) return;
      var open = categoryActive(item) ? " open" : "";
      var links = item.items.filter(linkVisible).map(function (l) {
        return '<a href="' + l.href + '" class="drawer-link' + (isActive(l.href) ? " active" : "") + '">' + esc(l.label) + "</a>";
      }).join("");
      html +=
        '<div class="drawer-cat' + open + '">' +
          '<button type="button" class="drawer-cat-btn">' + esc(item.label) + '<span class="chev"></span></button>' +
          '<div class="drawer-cat-items">' + links + "</div>" +
        "</div>";
    });
    return html;
  }

  function buildShell() {
    return (
      '<div class="site-top">' +
        '<header class="site-header">' +
          '<a href="index.html" class="brand">' +
            MARK +
            '<span class="brand-name">CORTEX OS</span>' +
            '<span class="brand-divider">|</span>' +
            '<span class="brand-sub">Right Idea Media &amp; Creative</span>' +
          "</a>" +
          '<button type="button" class="nav-burger" aria-label="Menu"><span></span><span></span><span></span></button>' +
        "</header>" +
        '<nav class="site-nav">' + buildDesktopNav() + "</nav>" +
      "</div>" +
      '<div class="nav-backdrop"></div>' +
      '<aside class="nav-drawer" aria-label="Navigation">' +
        '<div class="drawer-head">' + MARK + '<span class="brand-name">CORTEX OS</span></div>' +
        '<div class="drawer-body">' + buildDrawer() + "</div>" +
      "</aside>"
    );
  }

  // ---- Injection + wiring ----
  function injectStyles() {
    if (document.getElementById("cortex-shell-style")) return;
    var s = document.createElement("style");
    s.id = "cortex-shell-style";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function injectShell() {
    var existingTop = document.querySelector(".site-top");
    var wrapper = document.createElement("div");
    wrapper.innerHTML = buildShell();
    var nodes = Array.prototype.slice.call(wrapper.childNodes);
    if (existingTop && existingTop.parentNode) existingTop.parentNode.removeChild(existingTop);
    var oldBackdrop = document.querySelector(".nav-backdrop");
    var oldDrawer = document.querySelector(".nav-drawer");
    if (oldBackdrop) oldBackdrop.remove();
    if (oldDrawer) oldDrawer.remove();
    for (var i = nodes.length - 1; i >= 0; i--) {
      document.body.insertBefore(nodes[i], document.body.firstChild);
    }
    wire();
  }

  function wire() {
    // Desktop dropdowns: click toggles (hover handled by CSS).
    document.querySelectorAll(".nav-dd .dd-toggle").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        var dd = btn.parentNode;
        var wasOpen = dd.classList.contains("open");
        document.querySelectorAll(".nav-dd.open").forEach(function (d) { d.classList.remove("open"); });
        if (!wasOpen) dd.classList.add("open");
        btn.setAttribute("aria-expanded", String(!wasOpen));
      });
    });
    document.addEventListener("click", function () {
      document.querySelectorAll(".nav-dd.open").forEach(function (d) { d.classList.remove("open"); });
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { closeDrawer(); document.querySelectorAll(".nav-dd.open").forEach(function (d) { d.classList.remove("open"); }); }
    });

    // Mobile drawer.
    var burger = document.querySelector(".nav-burger");
    var drawer = document.querySelector(".nav-drawer");
    var backdrop = document.querySelector(".nav-backdrop");
    function openDrawer() { drawer.classList.add("open"); backdrop.classList.add("open"); burger.classList.add("open"); }
    function close() { closeDrawer(); }
    window.closeDrawer = function () {
      if (drawer) drawer.classList.remove("open");
      if (backdrop) backdrop.classList.remove("open");
      if (burger) burger.classList.remove("open");
    };
    function closeDrawer() { window.closeDrawer(); }
    if (burger) burger.addEventListener("click", function () {
      drawer.classList.contains("open") ? close() : openDrawer();
    });
    if (backdrop) backdrop.addEventListener("click", close);

    // Drawer category accordions.
    document.querySelectorAll(".drawer-cat-btn").forEach(function (btn) {
      btn.addEventListener("click", function () {
        btn.parentNode.classList.toggle("open");
      });
    });
  }

  function mountBot() {
    if (!document.getElementById("cortex-bot-css")) {
      var link = document.createElement("link");
      link.id = "cortex-bot-css";
      link.rel = "stylesheet";
      link.href = BOT_CSS_URL;
      document.head.appendChild(link);
    }
    import(BOT_JS_URL)
      .then(function (mod) {
        if (mod && typeof mod.createChat === "function") {
          mod.createChat({
            webhookUrl: BOT_WEBHOOK_URL,
            mode: "window",
            showWelcomeScreen: false,
            initialMessages: [
              "Hi! I'm the CORTEX ticket assistant.",
              "Tell me the client and what you need, and I'll open a ticket in Monday."
            ],
            i18n: {
              en: {
                title: "CORTEX Ticket Bot",
                subtitle: "Create a Monday ticket from any page.",
                footer: "",
                getStarted: "New ticket",
                inputPlaceholder: "Describe the ticket…"
              }
            }
          });
        }
      })
      .catch(function (e) {
        if (window.console) console.warn("CORTEX ticket bot failed to load:", e);
      });
  }

  function injectFavicons() {
    if (document.getElementById("cortex-favicons")) return;
    var tags = [
      ["link", { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],
      ["link", { rel: "icon", type: "image/png", sizes: "32x32", href: "/favicon-32x32.png" }],
      ["link", { rel: "icon", type: "image/png", sizes: "16x16", href: "/favicon-16x16.png" }],
      ["link", { rel: "apple-touch-icon", sizes: "180x180", href: "/favicon-180x180.png" }],
      ["meta", { name: "theme-color", content: "#0A0A0F" }]
    ];
    var marker = document.createElement("meta");
    marker.id = "cortex-favicons";
    document.head.appendChild(marker);
    tags.forEach(function (t) {
      var el = document.createElement(t[0]);
      Object.keys(t[1]).forEach(function (k) { el.setAttribute(k, t[1][k]); });
      document.head.appendChild(el);
    });
  }

  function init() {
    injectStyles();
    injectFavicons();
    // Render immediately with safe defaults (admin-only links hidden),
    // then re-render once real permissions arrive.
    injectShell();
    fetchPerms().then(function () { injectShell(); });
    mountBot();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

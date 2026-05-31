/* =====================================================================
   cortex-shell.js — shared chrome for every Córtex OS page.
   Injects the top navigation (with automatic active-page highlight)
   and carries its own styles, so individual pages no longer hand-copy
   the nav markup or its CSS.

   USAGE: add ONE line near the end of each page's <body>:
     <script src="/cortex-shell.js" defer></script>
   Then DELETE the hand-written <div class="site-top">…</div> block and
   the nav CSS rules from that page (the shell provides both).

   ADD A PAGE: edit the NAV_LINKS array below — once — and every page
   picks it up automatically.
   ===================================================================== */
(function () {
  "use strict";

  // ---- Ticket bot (n8n hosted chat widget) ----
  var BOT_WEBHOOK_URL = "https://naterimc.app.n8n.cloud/webhook/80464afc-47e2-4cd9-9164-1f2a9aac272e/chat";
  var BOT_CSS_URL     = "https://cdn.jsdelivr.net/npm/@n8n/chat/dist/style.css";
  var BOT_JS_URL      = "https://cdn.jsdelivr.net/npm/@n8n/chat/dist/chat.bundle.es.js";

  // ---- Single source of truth for the nav. Add new pages here. ----
  var NAV_LINKS = [
    { label: "Home",            href: "index.html" },
    { label: "Call Tracking",   href: "call-tracking.html" },
    { label: "Ad Spend Pacing", href: "ad-spend-pacing.html" },
    { label: "Campaign Triage", href: "triage.html" },
    { label: "Tickets",         href: "tickets.html" }
  ];

  // ---- Styles (identical to the original per-page nav CSS) ----
  var CSS = '' +
    '.site-top{position:sticky;top:0;z-index:100;}' +
    '.site-header{background:#0d1b2a;padding:0 32px;height:52px;display:flex;align-items:center;box-shadow:0 1px 0 rgba(255,255,255,.06);}' +
    '.brand{display:flex;align-items:center;gap:10px;text-decoration:none;}' +
    '.brand-name{font-size:17px;font-weight:700;color:#fff;letter-spacing:-.3px;}' +
    '.brand-divider{color:rgba(255,255,255,.25);font-size:14px;}' +
    '.brand-sub{font-size:11px;color:rgba(255,255,255,.45);font-weight:500;}' +
    '.site-nav{background:#0f2236;padding:0 32px;display:flex;gap:2px;border-bottom:1px solid rgba(255,255,255,.07);}' +
    '.nav-link{color:rgba(255,255,255,.5);text-decoration:none;font-size:13px;font-weight:500;padding:10px 16px;border-bottom:2px solid transparent;transition:color .15s,border-color .15s;}' +
    '.nav-link:hover{color:rgba(255,255,255,.85);}' +
    '.nav-link.active{color:#fff;border-bottom-color:#4285F4;}' +
    /* ---- n8n chat widget: position bottom-LEFT + Cortex theming ---- */
    ':root{' +
      '--chat--color-primary:#1565c0;' +
      '--chat--color-primary-shade-50:#125ab0;' +
      '--chat--color-primary-shade-100:#0f4f9c;' +
      '--chat--color-secondary:#0d1b2a;' +
      '--chat--toggle--background:#1565c0;' +
      '--chat--toggle--hover--background:#125ab0;' +
      '--chat--toggle--active--background:#0f4f9c;' +
      '--chat--toggle--color:#fff;' +
      '--chat--header--background:#0d1b2a;' +
      '--chat--header--color:#fff;' +
      '--chat--window--width:380px;' +
      '--chat--window--height:560px;' +
    '}' +
    /* move launcher + window to the bottom-left corner */
    '.n8n-chat .chat-window-toggle,' +
    '.n8n-chat .chat-window-wrapper{right:auto !important;left:20px !important;}' +
    '.n8n-chat .chat-window{right:auto !important;left:20px !important;}' +
    /* ---- swap the default chat-bubble launcher icon for a ticket icon ---- */
    /* hide n8n's built-in toggle SVG... */
    '.n8n-chat .chat-window-toggle svg{display:none !important;}' +
    /* ...and paint a ticket glyph via a mask so it inherits the toggle color */
    '.n8n-chat .chat-window-toggle::after{' +
      'content:"";' +
      'width:26px;height:26px;' +
      'background-color:var(--chat--toggle--color,#fff);' +
      "-webkit-mask:url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"black\"><path d=\"M22 10V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v4a2 2 0 0 1 0 4v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 1 0-4zM13 5.5h-2v2h2zm0 5h-2v3h2zm0 6h-2v2h2z\"/></svg>') center/contain no-repeat;" +
      "mask:url('data:image/svg+xml;utf8,<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"black\"><path d=\"M22 10V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v4a2 2 0 0 1 0 4v4a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-4a2 2 0 0 1 0-4zM13 5.5h-2v2h2zm0 5h-2v3h2zm0 6h-2v2h2z\"/></svg>') center/contain no-repeat;" +
    '}';

  // ---- Figure out which link is the current page ----
  function currentFile() {
    var path = window.location.pathname;
    var last = path.substring(path.lastIndexOf("/") + 1);
    if (last === "" ) return "index.html";        // "/" -> home
    return last;                                   // e.g. "triage" or "triage.html"
  }
  function isActive(href) {
    var cur = currentFile();
    // tolerate both "triage" and "triage.html" (Cloudflare Pages serves clean URLs)
    var hrefBase = href.replace(/\.html$/, "");
    var curBase  = cur.replace(/\.html$/, "");
    return hrefBase === curBase || (curBase === "index" && hrefBase === "index");
  }

  function buildNav() {
    var links = NAV_LINKS.map(function (l) {
      var cls = "nav-link" + (isActive(l.href) ? " active" : "");
      return '<a href="' + l.href + '" class="' + cls + '">' + l.label + '</a>';
    }).join("");

    var html =
      '<div class="site-top">' +
        '<header class="site-header">' +
          '<a href="index.html" class="brand">' +
            '<span class="brand-name">Córtex OS</span>' +
            '<span class="brand-divider">|</span>' +
            '<span class="brand-sub">Right Idea Media &amp; Creative</span>' +
          '</a>' +
        '</header>' +
        '<nav class="site-nav">' + links + '</nav>' +
      '</div>';
    return html;
  }

  function injectStyles() {
    if (document.getElementById("cortex-shell-style")) return;
    var s = document.createElement("style");
    s.id = "cortex-shell-style";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function injectNav() {
    // If a hand-written .site-top already exists (mid-migration), replace it
    // so we never get two navs.
    var existing = document.querySelector(".site-top");
    var wrapper = document.createElement("div");
    wrapper.innerHTML = buildNav();
    var nav = wrapper.firstChild;
    if (existing && existing.parentNode) {
      existing.parentNode.replaceChild(nav, existing);
    } else {
      document.body.insertBefore(nav, document.body.firstChild);
    }
  }

  function mountBot() {
    // Load n8n's chat stylesheet once.
    if (!document.getElementById("cortex-bot-css")) {
      var link = document.createElement("link");
      link.id = "cortex-bot-css";
      link.rel = "stylesheet";
      link.href = BOT_CSS_URL;
      document.head.appendChild(link);
    }
    // The widget bundle is an ES module — load it dynamically and init.
    import(BOT_JS_URL)
      .then(function (mod) {
        if (mod && typeof mod.createChat === "function") {
          mod.createChat({
            webhookUrl: BOT_WEBHOOK_URL,
            mode: "window",          // floating launcher + popup panel
            showWelcomeScreen: false,
            initialMessages: [
              "Hi! 👋 I'm the Córtex ticket assistant.",
              "Tell me the client and what you need, and I'll open a ticket in Monday."
            ],
            i18n: {
              en: {
                title: "Córtex Ticket Bot",
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
        if (window.console) console.warn("Córtex ticket bot failed to load:", e);
      });
  }

  function init() {
    injectStyles();
    injectNav();
    mountBot();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();

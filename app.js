const site = window.location.hostname;
const extensionApi = typeof browser !== "undefined" ? browser : chrome;
const DEFAULT_BACKEND_URL = "http://localhost:3000";
const DEFAULT_DOWNLOAD_PATH = "/downloads";
const dismissedDownloads = new Set();

function storageGet(keys, callback) {
  const result = extensionApi.storage.local.get(keys);

  if (result && typeof result.then === "function") {
    result.then(callback);
    return;
  }

  extensionApi.storage.local.get(keys, callback);
}

function getBackendUrl(result) {
  return (result.backendUrl || DEFAULT_BACKEND_URL).replace(/\/$/, "");
}

function downloadFromBackend(backendUrl, id) {
  const url = `${backendUrl}/file/${id}`;

  if (extensionApi.runtime && extensionApi.runtime.sendMessage) {
    extensionApi.runtime.sendMessage({ type: "downloadFromBackend", url }, (response) => {
      if (response && response.ok) return;

      window.open(url, "_blank", "noopener");
    });
    return;
  }

  window.open(url, "_blank", "noopener");
}

function watchBackendDownload(backendUrl, id) {
  if (!extensionApi.runtime || !extensionApi.runtime.sendMessage) return;

  extensionApi.runtime.sendMessage({
    type: "watchBackendDownload",
    backendUrl,
    id,
  });
}

if (extensionApi.runtime && extensionApi.runtime.onMessage) {
  extensionApi.runtime.onMessage.addListener((message) => {
    if (!message || !message.id) return;

    if (message.type === "backendDownloadDone") {
      addOrUpdateSidebar(message.id, {
        progress: 100,
        status: "done",
        filename: message.filename || null,
      });
      showToast("Download Pronto!", 4000, true);
    }

    if (message.type === "backendDownloadError") {
      addOrUpdateSidebar(message.id, {
        progress: 0,
        status: "error",
        error: message.error || "Erro no download",
      });
      showToast("Erro no download");
    }
  });
}

startObserver();

function startObserver() {
  if (!document.body) return;

  const observer = new MutationObserver(() => {
    if (
      site.includes("twitter.com") ||
      site.includes("x.com")
    ) {
      injectTwitterButtons();
    }

    if (site.includes("instagram.com")) {
      injectInstagramButtons();
    }

    injectNativeVideoButtons();
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  if (
    site.includes("twitter.com") ||
    site.includes("x.com")
  ) {
    injectTwitterButtons();
  }

  if (site.includes("instagram.com")) {
    injectInstagramButtons();
  }

  injectNativeVideoButtons();
}

function injectNativeVideoButtons() {
  if (document.getElementById("media-harvest-native-button")) return;

  document
    .querySelectorAll(".media-harvest-native-button")
    .forEach((button) => button.remove());

  ensureNativeVideoStyle();

  const button = document.createElement("div");
  button.id = "media-harvest-native-button";
  button.className = "media-harvest-native-button";
  button.setAttribute("data-media-harvest-native", "true");
  button.innerHTML = `
    <div class="media-harvest-native-label">
      <span>Media Harvest</span>
      <small>Baixar video</small>
    </div>
    <div class="media-harvest-native-actions">
      <button type="button" class="media-harvest-native-option" data-native-download="whatsapp">WhatsApp</button>
      <button type="button" class="media-harvest-native-option primary" data-native-download="original">Full</button>
    </div>
  `;

  let activeVideo = null;

  const hideButton = () => {
    activeVideo = null;
    button.classList.remove("media-harvest-native-button-visible");
    button.dataset.mediaHarvestUrl = "";
  };

  const getVideoAtPoint = (x, y) => {
    return [...document.querySelectorAll("video")]
      .map((video) => ({ video, rect: video.getBoundingClientRect() }))
      .filter(({ rect }) => {
        return (
          rect.width >= 160 &&
          rect.height >= 90 &&
          x >= rect.left &&
          x <= rect.right &&
          y >= rect.top &&
          y <= rect.bottom
        );
      })
      .sort((a, b) => {
        return a.rect.width * a.rect.height - b.rect.width * b.rect.height;
      })[0]?.video || null;
  };

  const showButtonForVideo = (video) => {
    const rect = video.getBoundingClientRect();
    const mediaUrl = video.currentSrc || video.src || "";
    const isBlobUrl = mediaUrl.startsWith("blob:");

    activeVideo = video;
    button.dataset.mediaHarvestUrl = window.location.href;
    button.dataset.mediaHarvestMediaUrl = mediaUrl && !isBlobUrl ? mediaUrl : "";
    button.dataset.mediaHarvestFallback = isBlobUrl ? "blob" : "page";
    button.style.display = "flex";
    button.style.left = `${Math.max(12, rect.right - 278)}px`;
    button.style.top = `${Math.max(12, rect.top + 14)}px`;
    button.classList.add("media-harvest-native-button-visible");
  };

  document.addEventListener(
    "mousemove",
    (event) => {
      if (button.contains(event.target)) return;

      const video = getVideoAtPoint(event.clientX, event.clientY);

      if (video) {
        showButtonForVideo(video);
      } else if (!button.matches(":hover")) {
        hideButton();
      }
    },
    { passive: true }
  );

  window.addEventListener(
    "scroll",
    () => {
      if (activeVideo) showButtonForVideo(activeVideo);
    },
    { passive: true }
  );

  window.addEventListener("resize", hideButton);
  button.addEventListener("mouseleave", hideButton);
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  button.addEventListener("click", startNativeVideoDownload);

  document.body.appendChild(button);
}

function startNativeVideoDownload(event) {
  event.preventDefault();
  event.stopPropagation();

  const option = event.target.closest("[data-native-download]");

  if (!option) return;

  const button = option.closest("#media-harvest-native-button");
  const url = button.dataset.mediaHarvestUrl;
  const fallback = button.dataset.mediaHarvestFallback;
  const download = option.dataset.nativeDownload || "original";

  if (!url) return;

  if (fallback === "blob") {
    showToast("Video usa blob; usando a URL da pagina para pegar a melhor qualidade", 2500);
  }

  storageGet(["locationPath", "backendUrl"], async (result) => {
    const backendUrl = getBackendUrl(result);
    const locationPath = result.locationPath || DEFAULT_DOWNLOAD_PATH;

    try {
      const response = await fetch(backendUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url,
          path: locationPath,
          download,
        }),
      });

      if (!response.ok) throw new Error("Erro backend");

      const data = await response.json().catch(() => null);
      showToast("Download Iniciado!");

      if (data && data.id) {
        try { addOrUpdateSidebar(data.id, { progress: 0, status: "in_progress", filename: data.filename || null }); } catch (e) {}
        watchBackendDownload(backendUrl, data.id);
        pollStatus(backendUrl, data.id, (status) => {
          if (status === "done") {
            showToast("Download Pronto!", 4000, true);
          } else if (status === "error") {
            showToast("Erro no download");
          }
        });
      }
    } catch (err) {
      showToast("Erro ao conectar backend");
    }
  });
}

function ensureNativeVideoStyle() {
  if (document.getElementById("media-harvest-native-style")) return;

  const style = document.createElement("style");
  style.id = "media-harvest-native-style";
  style.textContent = `
    .media-harvest-native-button { position:fixed; z-index:2147483647; display:none; align-items:center; gap:8px; width:264px; border:1px solid rgba(255,255,255,.22); border-radius:16px; padding:7px; background:rgba(9,12,18,.88); color:#fff; font:600 12px Arial,sans-serif; box-shadow:0 16px 36px rgba(0,0,0,.45); opacity:0; pointer-events:none; transform:translateY(-6px); transition:opacity .16s ease, transform .16s ease, background .16s ease; backdrop-filter:blur(12px); }
    .media-harvest-native-label { flex:0 0 88px; min-width:0; padding-left:6px; display:flex; flex-direction:column; gap:1px; line-height:1.1; }
    .media-harvest-native-label span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:800; }
    .media-harvest-native-label small { color:rgba(255,255,255,.62); font-size:10px; font-weight:700; letter-spacing:.03em; text-transform:uppercase; }
    .media-harvest-native-actions { flex:1; display:grid; grid-template-columns:1fr 1fr; gap:6px; overflow:hidden; }
    .media-harvest-native-option { border:0; border-radius:11px; padding:9px 8px; background:rgba(255,255,255,.12); color:#fff; cursor:pointer; font:800 12px Arial,sans-serif; transform:translateX(14px); opacity:.92; transition:transform .18s ease, opacity .18s ease, background .15s ease; }
    .media-harvest-native-option.primary { background:linear-gradient(135deg,#7c9cff,#8f5cff); }
    .media-harvest-native-option:hover { background:rgba(255,255,255,.22); opacity:1; }
    .media-harvest-native-option.primary:hover { background:linear-gradient(135deg,#91aaff,#a172ff); }
    .media-harvest-native-button-visible { opacity:1; pointer-events:auto; transform:translateY(0); }
    .media-harvest-native-button-visible .media-harvest-native-option { transform:translateX(0); }
  `;

  document.head.appendChild(style);
}

function injectTwitterButtons() {
  const dropdowns = document.querySelectorAll(
    '[data-testid="Dropdown"]'
  );

  dropdowns.forEach((dropdown) => {
    if (
      dropdown.querySelector(
        "[data-media-harvest-twitter]"
      )
    ) {
      return;
    }

    const copyButton = [
      ...dropdown.querySelectorAll('[role="menuitem"]'),
    ].find((el) => {
      return (
        el.innerText.includes("Copiar link") ||
        el.innerText.includes("Copy link")
      );
    });

    if (!copyButton) return;

    const hdButton = createTwitterButton(
      copyButton,
      "Baixar HD",
      "twitter"
    );

    const whatsappButton = createTwitterButton(
      copyButton,
      "Baixar WhatsApp",
      "whatsapp"
    );

    dropdown.appendChild(hdButton);

    dropdown.appendChild(whatsappButton);
  });
}

function createTwitterButton(
  baseButton,
  text,
  type
) {
  const button = document.createElement("div");

  button.innerHTML = baseButton.innerHTML;

  button.className = baseButton.className;

  button.setAttribute("role", "menuitem");

  button.setAttribute(
    "data-media-harvest-twitter",
    "true"
  );

  button.setAttribute("data-download-type", type);

  const span = button.querySelector("span");

  if (span) {
    span.innerText = text;
  }

  button.style.cursor = "pointer";
  button.style.display = "flex";
  button.style.alignItems = "center";
  button.style.justifyContent = "center";
  button.style.width = "100%";
  button.style.transition = "transform 0.12s ease, background 0.12s ease";

  button.tabIndex = 0;

  button.addEventListener("mouseenter", () => {
    try {
      button.style.transform = "scale(1.04)";
      button.style.background = "rgba(0,0,0,0.06)";
    } catch (e) {}
  });

  button.addEventListener("mouseleave", () => {
    try {
      button.style.transform = "scale(1)";
      button.style.background = "";
    } catch (e) {}
  });

  return button;
}

function ensureSidebar() {
  if (document.getElementById("media-harvest-sidebar")) return;

  const style = document.createElement("style");
  style.id = "media-harvest-sidebar-style";
  style.innerHTML = `
    #media-harvest-sidebar { position: fixed; right: 16px; top: 80px; width: 340px; max-width: calc(100vw - 32px); max-height: calc(100vh - 120px); overflow:auto; z-index:2147483646; display:flex; flex-direction:column; gap:10px; pointer-events:none; }
    .mh-download-item { pointer-events:auto; background:rgba(9,12,18,.88); color:#fff; padding:13px; border:1px solid rgba(255,255,255,.12); border-radius:16px; box-shadow:0 20px 48px rgba(0,0,0,.42); font-family:Arial,sans-serif; font-size:13px; backdrop-filter:blur(14px); }
    .mh-download-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; margin-bottom:9px; }
    .mh-download-title { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-weight:800; font-size:13px; }
    .mh-download-actions { display:flex; align-items:center; gap:8px; flex:0 0 auto; }
    .mh-download-pct { color:#9db3ff; font-weight:800; font-size:13px; }
    .mh-download-close { width:22px; height:22px; border:0; border-radius:999px; background:rgba(255,255,255,.12); color:#fff; cursor:pointer; font:800 14px/1 Arial,sans-serif; display:grid; place-items:center; padding:0; }
    .mh-download-close:hover { background:rgba(255,255,255,.22); }
    .mh-download-progress { background:rgba(255,255,255,0.12); height:9px; border-radius:999px; overflow:hidden; }
    .mh-download-progress > .bar { height:100%; width:0%; background:linear-gradient(90deg,#37e39f,#7c9cff,#a46cff); border-radius:999px; transition:width .35s ease; }
    .mh-download-meta { display:flex; justify-content:space-between; gap:10px; margin-top:8px; font-size:12px; color:rgba(255,255,255,.78); align-items:center; }
    .mh-download-status { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .mh-spinner { flex:0 0 auto; width:16px; height:16px; border:3px solid rgba(255,255,255,0.2); border-top-color:#9db3ff; border-radius:50%; animation:mh-spin 1s linear infinite; }
    .mh-download-item.done .mh-download-pct { color:#37e39f; }
    .mh-download-item.error .mh-download-pct { color:#ff6573; }
    @keyframes mh-spin { to { transform: rotate(360deg); } }
  `;

  const container = document.createElement("div");
  container.id = "media-harvest-sidebar";

  document.head.appendChild(style);
  document.body.appendChild(container);
}

function addOrUpdateSidebar(id, info = {}) {
  try {
    if (dismissedDownloads.has(id)) return;

    ensureSidebar();

    const container = document.getElementById("media-harvest-sidebar");
    let item = document.getElementById(`mh-download-${id}`);

    if (!item) {
      item = document.createElement("div");
      item.className = "mh-download-item";
      item.id = `mh-download-${id}`;

      const head = document.createElement("div");
      head.className = "mh-download-head";

      const title = document.createElement("div");
      title.className = "mh-download-title";
      title.innerText = info.filename || `Download ${id}`;

      const pct = document.createElement("div");
      pct.className = "mh-download-pct";
      pct.innerText = "0%";

      const closeButton = document.createElement("button");
      closeButton.type = "button";
      closeButton.className = "mh-download-close";
      closeButton.setAttribute("aria-label", "Fechar status de download");
      closeButton.textContent = "x";
      closeButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        dismissedDownloads.add(id);
        item.remove();
      });

      const actions = document.createElement("div");
      actions.className = "mh-download-actions";
      actions.appendChild(pct);
      actions.appendChild(closeButton);

      head.appendChild(title);
      head.appendChild(actions);

      const progressWrap = document.createElement("div");
      progressWrap.className = "mh-download-progress";

      const bar = document.createElement("div");
      bar.className = "bar";
      progressWrap.appendChild(bar);

      const meta = document.createElement("div");
      meta.className = "mh-download-meta";

      const status = document.createElement("div");
      status.className = "mh-download-status";
      status.innerText = "Preparando download...";

      const spinner = document.createElement("div");
      spinner.className = "mh-spinner";
      spinner.style.display = info.status === 'in_progress' ? 'block' : 'none';

      meta.appendChild(status);
      meta.appendChild(spinner);

      item.appendChild(head);
      item.appendChild(progressWrap);
      item.appendChild(meta);

      container.prepend(item);
    }

    const title = item.querySelector(".mh-download-title");
    const progressWrap = item.querySelector(".mh-download-progress");
    const bar = item.querySelector(".mh-download-progress > .bar");
    const status = item.querySelector(".mh-download-status");
    const pct = item.querySelector(".mh-download-pct");
    const progress = Math.min(100, Math.max(0, Number(info.progress) || 0));

    if (title && info.filename) title.innerText = info.filename;
    if (bar) {
      if (progressWrap) progressWrap.style.display = "block";
      bar.style.width = `${info.status === "done" ? 100 : progress}%`;
    }

    if (pct) pct.innerText = `${info.status === "done" ? 100 : progress}%`;
    item.classList.toggle("done", info.status === "done");
    item.classList.toggle("error", info.status === "error");

    const spinnerEl = item.querySelector('.mh-spinner');
    if (spinnerEl) {
      if (info.status === 'in_progress') {
        spinnerEl.style.display = 'block';
        if (status) status.innerText = info.message || 'Baixando...';
      } else if (info.status === 'done') {
        spinnerEl.style.display = 'none';
        if (status) status.innerText = 'Concluído';
      } else if (info.status === 'error') {
        spinnerEl.style.display = 'none';
        if (status) status.innerText = info.error || 'Erro no download';
      }
    }

    if (info.status === "done") {
      item.style.opacity = "1";
      setTimeout(() => {
        try { item.remove(); } catch (e) {}
      }, 7000);
    }
  } catch (err) {}
}

function injectInstagramButtons() {
  injectInstagramFeedButtons();

  injectInstagramReels();
}

function injectInstagramFeedButtons() {
  const sections = document.querySelectorAll("section");

  sections.forEach((section) => {
    if (section.querySelector("[data-media-harvest]")) {
      return;
    }

    const shareButton = [
      ...section.querySelectorAll('[role="button"]'),
    ].find((el) => {
      return (
        el.querySelector(
          'svg[aria-label*="Compartilhar"]'
        ) ||
        el.querySelector(
          'svg[aria-label*="Share"]'
        )
      );
    });

    if (!shareButton) return;

    const parent = shareButton.parentElement;

    if (!parent) return;

    const hdButton = createInstagramButton("hd");

    const whatsappButton =
      createInstagramButton("whatsapp");

    parent.appendChild(hdButton);

    parent.appendChild(whatsappButton);
  });
}

function injectInstagramReels() {
  const reelsActionBarSelector =
    "div.html-div.xdj266r.x14z9mp.xexx8yu.xyri2b.x18d9i69.x1c1uobl.x9f619.xjbqb8w.x78zum5.x15mokao.x1ga7v0g.x16uus16.xbiv7yw.x12nagc.x1uhb9sk.x1plvlek.xryxfnj.x1c4vz4f.x2lah0s.xdt5ytf.xqjyukv.x6s0dn4.x1oa3qoh.x13a6bvl.x1diwwjn.x1247r65";

  const reelsContainers = [
    ...document.querySelectorAll(reelsActionBarSelector),
    ...document.querySelectorAll("div.x1oa3qoh"),
  ].filter(
    (container) => {
      const hasShareButton = container.querySelector(
        'svg[aria-label="Compartilhar"], svg[aria-label="Share"]'
      );

      const hasSaveButton = container.querySelector(
        'svg[aria-label="Salvar"], svg[aria-label="Save"]'
      );

      return hasShareButton && hasSaveButton;
    }
  );

  reelsContainers.forEach((container) => {
    if (container.querySelector("[data-media-harvest]")) return;

    const hdButton = createInstagramButton("hd");

    const whatsappButton = createInstagramButton("whatsapp");

    container.appendChild(hdButton);

    container.appendChild(whatsappButton);
  });
}

function createInstagramButton(type = "hd") {
  const button = document.createElement("div");

  button.setAttribute("data-media-harvest", "true");

  button.setAttribute("data-download-type", type);

  button.setAttribute("role", "button");

  button.style.cursor = "pointer";
  button.style.display = "flex";
  button.style.alignItems = "center";
  button.style.justifyContent = "center";
  button.style.width = "40px";
  button.style.height = "40px";
  button.style.borderRadius = "999px";
  button.style.background = "rgba(255,255,255,0.12)";
  button.style.backdropFilter = "blur(10px)";
  button.style.marginTop = "10px";
  button.style.marginLeft = "8px";
  button.style.color = "white";
  button.style.transition = "0.2s";

  button.addEventListener("mouseenter", () => {
    button.style.transform = "scale(1.1)";
    button.style.background = "rgba(255,255,255,0.2)";
  });

  button.addEventListener("mouseleave", () => {
    button.style.transform = "scale(1)";
    button.style.background = "rgba(255,255,255,0.12)";
  });

  if (type === "whatsapp") {
    button.title = "Baixar WhatsApp";

    button.innerHTML = `
      <svg
        fill="currentColor"
        height="22"
        viewBox="0 0 24 24"
        width="22"
      >
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.198.297-.768.966-.94 1.164-.173.198-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.372-.025-.52-.075-.149-.669-1.612-.916-2.206-.242-.579-.487-.5-.669-.51l-.57-.01c-.198 0-.52.075-.792.372-.272.298-1.04 1.016-1.04 2.479s1.065 2.875 1.213 3.074c.149.198 2.095 3.2 5.077 4.487.71.306 1.263.489 1.694.626.712.227 1.36.195 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414-.074-.124-.272-.198-.57-.347z"/>
      </svg>
    `;
  } else {
    button.title = "Baixar HD";

    button.innerHTML = `
      <svg
        fill="currentColor"
        height="24"
        viewBox="0 0 24 24"
        width="24"
      >
        <path d="M12 16l4-5h-3V4h-2v7H8l4 5zm-7 2h14v2H5v-2z"></path>
      </svg>
    `;
  }

  return button;
}

document.addEventListener(
  "click",
  async (e) => {
    const button = e.target.closest(
      "[data-media-harvest-twitter]"
    );

    if (!button) return;

    e.preventDefault();

    e.stopPropagation();

    const type =
      button.getAttribute("data-download-type");

    try {
      // pega todos tweets visíveis
      const tweets = [
        ...document.querySelectorAll("article"),
      ];

      let tweetUrl = null;

      // pega o tweet que está com menu aberto
      for (const tweet of tweets) {
        const menuOpen = tweet.querySelector(
          '[aria-expanded="true"]'
        );

        if (!menuOpen) continue;

        const links = [
          ...tweet.querySelectorAll(
            'a[href*="/status/"]'
          ),
        ];

        const valid = links.find((a) => {
          return (
            a.href &&
            a.href.includes("/status/")
          );
        });

        if (valid) {
          tweetUrl = valid.href.split("?")[0];
          break;
        }
      }

      if (!tweetUrl) {
        const current = window.location.href;

        if (current.includes("/status/")) {
          tweetUrl = current.split("?")[0];
        }
      }

      if (!tweetUrl) {
        showToast("Tweet URL não encontrada");
        return;
      }

      storageGet(
        ["locationPath", "backendUrl"],
        async (result) => {
          const backendUrl = getBackendUrl(result);
          const locationPath = result.locationPath || DEFAULT_DOWNLOAD_PATH;

          try {
            const response = await fetch(
              backendUrl,
              {
                method: "POST",
                headers: {
                  "Content-Type":
                    "application/json",
                },
                body: JSON.stringify({
                  url: tweetUrl,
                  path: locationPath,
                  download:
                    type === "whatsapp"
                      ? "whatsapp"
                      : "twitter",
                }),
              }
            );

            if (!response.ok) {
              throw new Error(
                "Erro backend"
              );
            }

            const data = await response.json().catch(() => null);

            if (data && data.id) {
              // create sidebar entry immediately
              try { addOrUpdateSidebar(data.id, { progress: 0, status: 'in_progress', filename: data.filename || null }); } catch (e) {}
              watchBackendDownload(backendUrl, data.id);
              pollStatus(backendUrl, data.id, (status) => {
                if (status === "done") {
                  showToast("Download Pronto!", 4000, true);
                } else if (status === "error") {
                  showToast("Erro no download");
                }
              });
            }
          } catch (err) {
            console.error(err);

            showToast("Erro ao conectar backend");
          }
        }
      );
    } catch (err) {
      console.error(err);
    }
  },
  true
);

function ensureToastContainer() {
  if (document.getElementById("media-harvest-toast-container")) return;

  const style = document.createElement("style");
  style.id = "media-harvest-toast-style";
  style.innerHTML = `
    #media-harvest-toast-container { position: fixed; right: 16px; bottom: 24px; z-index: 2147483647; display:flex; flex-direction:column; gap:8px; align-items: flex-end; }
    .media-harvest-toast { background: rgba(0,0,0,0.85); color: white; padding: 10px 14px; border-radius: 8px; box-shadow: 0 6px 18px rgba(0,0,0,0.35); max-width: 320px; font-family: Arial, sans-serif; font-size: 13px; opacity: 0; transform: translateY(8px); transition: opacity .18s ease, transform .18s ease; }
    .media-harvest-toast.show { opacity: 1; transform: translateY(0); }
    .media-harvest-toast.large { font-size: 20px; font-weight: 700; padding: 14px 18px; }
  `;

  const container = document.createElement("div");
  container.id = "media-harvest-toast-container";

  document.head.appendChild(style);
  document.body.appendChild(container);
}

function showToast(message, duration = 3000, large = false) {
  try {
    ensureToastContainer();

    const container = document.getElementById("media-harvest-toast-container");
    const toast = document.createElement("div");
    toast.className = "media-harvest-toast";
    if (large) toast.classList.add("large");
    toast.innerText = message;

    container.appendChild(toast);

    // force reflow then show
    // eslint-disable-next-line no-unused-expressions
    toast.offsetHeight;
    toast.classList.add("show");

    setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => {
        toast.remove();
      }, 200);
    }, duration);
  } catch (err) {}
}

function pollStatus(backendUrl, id, cb) {
  const url = `${backendUrl}/status/${id}`;

  const interval = setInterval(() => {
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error("Status não encontrado");
        return r.json();
      })
      .then((data) => {
        // update sidebar with latest info
        try {
          addOrUpdateSidebar(id, {
            progress: typeof data.progress !== "undefined" ? data.progress : 0,
            filename: data.filename || null,
            status: data.status || "in_progress",
            message: data.message || null,
            error: data.error || null,
          });
        } catch (err) {}

        if (data.status === "done") {
          clearInterval(interval);
          cb("done");
        } else if (data.status === "error") {
          clearInterval(interval);
          cb("error");
        }
      })
      .catch((err) => {
        clearInterval(interval);
      });
  }, 2000);
}

document.addEventListener(
  "click",
  async (e) => {
    const button = e.target.closest(
      "[data-media-harvest]"
    );

    if (!button) return;

    e.preventDefault();

    e.stopPropagation();

    const type =
      button.getAttribute("data-download-type");

    storageGet(
      ["locationPath", "backendUrl"],
      async (result) => {
        const backendUrl = getBackendUrl(result);
        const locationPath = result.locationPath || DEFAULT_DOWNLOAD_PATH;

        try {
          const response = await fetch(
            backendUrl,
            {
              method: "POST",
              headers: {
                "Content-Type":
                  "application/json",
              },
              body: JSON.stringify({
                url: window.location.href,
                path: locationPath,
                download:
                  type === "whatsapp"
                    ? "whatsapp"
                    : "instagram",
              }),
            }
          );

          if (!response.ok) {
            throw new Error("Erro backend");
          }

          const data = await response.json().catch(() => null);

          if (data && data.id) {
            try { addOrUpdateSidebar(data.id, { progress: 0, status: 'in_progress', filename: data.filename || null }); } catch (e) {}
            watchBackendDownload(backendUrl, data.id);
            pollStatus(backendUrl, data.id, (status) => {
                if (status === "done") {
                  showToast("Download Pronto!", 4000, true);
              } else if (status === "error") {
                  showToast("Erro no download");
              }
            });
          }
        } catch (err) {
          showToast("Erro ao conectar backend");
        }
      }
    );
  },
  true
);

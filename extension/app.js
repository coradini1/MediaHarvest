const site = window.location.hostname;
const extensionApi = typeof browser !== "undefined" ? browser : chrome;
const DEFAULT_BACKEND_URL = "http://localhost:3000";
const DEFAULT_DOWNLOAD_PATH = "/downloads";

function storageGet(keys, callback) {
  const result = extensionApi.storage.local.get(keys);

  if (result && typeof result.then === "function") {
    result.then(callback);
    return;
  }

  extensionApi.storage.local.get(keys, callback);
}

function getBackendUrl(result) {
  try {
    return new URL(result.backendUrl || DEFAULT_BACKEND_URL).origin;
  } catch (_) {
    return DEFAULT_BACKEND_URL;
  }
}

function isSite(domain) {
  return site === domain || site.endsWith(`.${domain}`);
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    extensionApi.runtime.sendMessage(message, (response) => {
      const error = extensionApi.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

function startManagedDownload(backendUrl, url, path, download) {
  return sendRuntimeMessage({
    type: "startDownload",
    backendUrl,
    payload: { url, path, download },
    meta: {
      title: document.title,
      pageUrl: window.location.href,
      source: window.location.hostname,
    },
  }).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "Não foi possível iniciar o download");
    return response.download;
  });
}

if (extensionApi.runtime && extensionApi.runtime.onMessage) {
  extensionApi.runtime.onMessage.addListener((message) => {
    if (message?.type === "downloadsUpdated") renderDownloads(message.downloads || []);
  });

  sendRuntimeMessage({ type: "getDownloads" })
    .then((response) => renderDownloads(response?.downloads || []))
    .catch(() => {});
}

let videoButtonEnabled = true;

storageGet(["showVideoButton"], (result) => {
  videoButtonEnabled = result?.showVideoButton !== false;
  startObserver();
});

if (extensionApi.storage && extensionApi.storage.onChanged) {
  extensionApi.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.showVideoButton) return;
    videoButtonEnabled = changes.showVideoButton.newValue !== false;
    if (videoButtonEnabled) injectPageControls();
    else removeNativeVideoButtons();
  });
}

function injectPageControls() {
  if (isSite("twitter.com") || isSite("x.com")) {
    injectTwitterButtons();
  }

  if (isSite("instagram.com")) {
    injectInstagramButtons();
  }

  injectNativeVideoButtons();
}

function startObserver() {
  if (!document.body) return;

  let observerTimer;
  const observer = new MutationObserver(() => {
    clearTimeout(observerTimer);
    observerTimer = setTimeout(injectPageControls, 120);
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  injectPageControls();
}

function removeNativeVideoButtons() {
  document
    .querySelectorAll("#media-harvest-native-button, .media-harvest-native-button")
    .forEach((button) => button.remove());
}

function injectNativeVideoButtons() {
  if (!videoButtonEnabled) return;
  if (sessionStorage.getItem(`mediaHarvestHidden:${site}`) === "true") return;
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
    <div class="media-harvest-native-actions">
      <button type="button" class="media-harvest-native-option" data-native-download="whatsapp" title="Baixar versão para WhatsApp">W</button>
      <button type="button" class="media-harvest-native-option primary" data-native-download="original" title="Baixar em qualidade original">Full</button>
      <button type="button" class="media-harvest-native-hide" title="Ocultar nesta aba" aria-label="Ocultar botão do Media Harvest">×</button>
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
    const visibleLeft = Math.max(0, rect.left);
    const visibleTop = Math.max(0, rect.top);
    const visibleRight = Math.min(window.innerWidth, rect.right);
    const visibleBottom = Math.min(window.innerHeight, rect.bottom);

    if (visibleRight - visibleLeft < 134 || visibleBottom - visibleTop < 41) {
      hideButton();
      return;
    }

    const mediaUrl = video.currentSrc || video.src || "";
    const isBlobUrl = mediaUrl.startsWith("blob:");

    activeVideo = video;
    button.dataset.mediaHarvestUrl = window.location.href;
    button.dataset.mediaHarvestMediaUrl = mediaUrl && !isBlobUrl ? mediaUrl : "";
    button.dataset.mediaHarvestFallback = isBlobUrl ? "blob" : "page";
    button.style.display = "flex";
    button.style.left = `${visibleRight - 126}px`;
    button.style.top = `${visibleTop + 8}px`;
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
  button.addEventListener("click", (event) => {
    if (event.target.closest(".media-harvest-native-hide")) {
      event.preventDefault();
      event.stopPropagation();
      sessionStorage.setItem(`mediaHarvestHidden:${site}`, "true");
      button.remove();
      showToast("Botão ocultado nesta aba");
      return;
    }

    startNativeVideoDownload(event);
  });

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

  option.disabled = true;

  storageGet(["locationPath", "backendUrl"], async (result) => {
    const backendUrl = getBackendUrl(result);
    const locationPath = result.locationPath || DEFAULT_DOWNLOAD_PATH;

    try {
      await startManagedDownload(backendUrl, url, locationPath, download);
      showToast("Download adicionado");
    } catch (err) {
      showToast(err.message || "Erro ao conectar ao servidor");
    } finally {
      option.disabled = false;
    }
  });
}

function ensureNativeVideoStyle() {
  if (document.getElementById("media-harvest-native-style")) return;

  const style = document.createElement("style");
  style.id = "media-harvest-native-style";
  style.textContent = `
    .media-harvest-native-button { position:fixed; z-index:2147483647; display:none; width:118px; padding:3px; border:1px solid rgba(255,255,255,.16); border-radius:7px; background:rgba(20,20,22,.94); color:#fff; font:600 11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; box-shadow:0 4px 16px rgba(0,0,0,.32); opacity:0; pointer-events:none; transform:translateY(-3px); transition:opacity .12s ease,transform .12s ease; }
    .media-harvest-native-actions { width:100%; display:grid; grid-template-columns:28px 1fr 24px; gap:3px; }
    .media-harvest-native-option,.media-harvest-native-hide { height:25px; padding:0 6px; border:0; border-radius:4px; background:#353537; color:#f5f5f5; cursor:pointer; font:600 11px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    .media-harvest-native-option:disabled { opacity:.55; cursor:wait; }
    .media-harvest-native-option.primary { background:#f1f1f1; color:#18181a; }
    .media-harvest-native-option:hover,.media-harvest-native-hide:hover { background:#4b4b4e; }
    .media-harvest-native-option.primary:hover { background:#fff; }
    .media-harvest-native-hide { color:#aaa; font-size:15px; padding:0; }
    .media-harvest-native-button-visible { opacity:1; pointer-events:auto; transform:translateY(0); }
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
    #media-harvest-sidebar { position:fixed; right:12px; top:68px; width:320px; max-width:calc(100vw - 24px); max-height:calc(100vh - 92px); z-index:2147483646; display:flex; flex-direction:column; gap:6px; pointer-events:none; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    #media-harvest-sidebar.mh-panel-collapsed { width:auto; }
    .mh-panel-head { pointer-events:auto; display:flex; align-items:center; justify-content:space-between; gap:10px; min-height:34px; padding:6px 7px 6px 10px; border:1px solid rgba(255,255,255,.14); border-radius:8px; background:rgba(24,24,26,.96); color:#f4f4f5; box-shadow:0 7px 24px rgba(0,0,0,.3); }
    .mh-panel-label { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:11px; font-weight:650; }
    .mh-panel-actions { display:flex; align-items:center; gap:4px; }
    .mh-panel-button { height:22px; padding:0 7px; border:1px solid #48484d; border-radius:4px; background:#29292c; color:#bdbdc2; cursor:pointer; font:600 9px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    .mh-panel-button:hover { border-color:#727278; color:#fff; }
    .mh-panel-list { min-height:0; display:flex; flex-direction:column; gap:6px; overflow:auto; pointer-events:none; scrollbar-width:thin; }
    .mh-panel-collapsed .mh-panel-list,.mh-panel-collapsed .mh-panel-clear { display:none; }
    .mh-download-item { pointer-events:auto; padding:11px; border:1px solid rgba(255,255,255,.14); border-radius:9px; background:rgba(24,24,26,.96); color:#f4f4f5; box-shadow:0 7px 24px rgba(0,0,0,.3); font:12px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    .mh-download-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; }
    .mh-download-copy { min-width:0; }
    .mh-download-title { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; font-weight:650; }
    .mh-download-source { margin-top:2px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#99999f; font-size:10px; }
    .mh-download-pct { flex:0 0 auto; color:#d4d4d8; font-variant-numeric:tabular-nums; font-weight:650; }
    .mh-download-progress { height:3px; margin-top:9px; overflow:hidden; border-radius:2px; background:#3f3f42; }
    .mh-download-progress>.bar { height:100%; width:0; background:#e4e4e7; transition:width .25s ease; }
    .mh-download-foot { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:8px; }
    .mh-download-status { min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#d0d0d4; font-size:10px; font-weight:550; }
    .mh-download-action { flex:0 0 auto; padding:3px 7px; border:1px solid #4a4a4e; border-radius:4px; background:transparent; color:#c8c8cd; cursor:pointer; font:600 10px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
    .mh-download-action:hover { border-color:#77777d; color:#fff; }
    .mh-download-item.done .mh-download-progress>.bar { background:#58a978; }
    .mh-download-item.error .mh-download-progress>.bar { background:#c65e65; }
    .mh-download-item.cancelled { opacity:.68; }
  `;

  const container = document.createElement("div");
  container.id = "media-harvest-sidebar";

  const panelHead = document.createElement("div");
  panelHead.className = "mh-panel-head";
  const panelLabel = document.createElement("div");
  panelLabel.className = "mh-panel-label";
  panelLabel.textContent = "Downloads";
  const panelActions = document.createElement("div");
  panelActions.className = "mh-panel-actions";
  const clearButton = document.createElement("button");
  clearButton.type = "button";
  clearButton.className = "mh-panel-button mh-panel-clear";
  clearButton.textContent = "Limpar";
  clearButton.title = "Remover downloads finalizados";
  clearButton.addEventListener("click", () => {
    sendRuntimeMessage({ type: "clearFinishedDownloads" }).catch((error) => showToast(error.message));
  });
  const collapseButton = document.createElement("button");
  collapseButton.type = "button";
  collapseButton.className = "mh-panel-button mh-panel-collapse";
  collapseButton.addEventListener("click", () => {
    const collapsed = container.classList.toggle("mh-panel-collapsed");
    sessionStorage.setItem("mediaHarvestDownloadsCollapsed", collapsed ? "true" : "false");
    collapseButton.textContent = collapsed ? "Mostrar" : "Ocultar";
    panelLabel.textContent = collapsed
      ? `Downloads · ${container.dataset.total || 0}`
      : `Downloads · ${container.dataset.active || 0} ativos`;
  });
  const list = document.createElement("div");
  list.className = "mh-panel-list";

  const collapsed = sessionStorage.getItem("mediaHarvestDownloadsCollapsed") === "true";
  container.classList.toggle("mh-panel-collapsed", collapsed);
  collapseButton.textContent = collapsed ? "Mostrar" : "Ocultar";
  panelActions.append(clearButton, collapseButton);
  panelHead.append(panelLabel, panelActions);
  container.append(panelHead, list);

  document.head.appendChild(style);
  document.body.appendChild(container);
}

function formatDownloadType(format) {
  if (format === "whatsapp") return "WhatsApp";
  if (format === "mp3") return "MP3";
  return "Original";
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let amount = bytes / 1024;
  let unit = units[0];
  for (let index = 1; amount >= 1024 && index < units.length; index += 1) {
    amount /= 1024;
    unit = units[index];
  }
  return `${amount.toFixed(amount >= 10 ? 0 : 1)} ${unit}`;
}

function downloadStatusText(download) {
  if (download.status === "done") return "Concluído e enviado ao navegador";
  if (download.status === "error") return download.error || "O download falhou";
  if (download.status === "cancelled") return "Cancelado";

  const details = [];
  if (download.message && download.message !== download.phase) details.push(download.message);
  else if (download.phase) details.push(download.phase);
  const downloaded = formatBytes(download.bytesDownloaded);
  const total = formatBytes(download.totalBytes);
  if (downloaded && total) details.push(`${downloaded} de ${total}`);
  else if (downloaded) details.push(downloaded);
  if (download.speed) details.push(`${download.speed}/s`);
  if (download.eta) details.push(`faltam ${download.eta}`);
  return details.join(" · ") || download.phase || download.message || "Preparando...";
}

function renderDownloads(downloads) {
  ensureSidebar();
  const container = document.getElementById("media-harvest-sidebar");
  const list = container.querySelector(".mh-panel-list");
  const label = container.querySelector(".mh-panel-label");
  const clearButton = container.querySelector(".mh-panel-clear");
  const activeCount = downloads.filter((download) =>
    ["queued", "in_progress", "transferring", "cancelling", "retrying", "ready_for_browser"].includes(download.status)
  ).length;
  const finishedCount = downloads.length - activeCount;

  container.dataset.total = String(downloads.length);
  container.dataset.active = String(activeCount);
  container.style.display = downloads.length ? "flex" : "none";
  label.textContent = container.classList.contains("mh-panel-collapsed")
    ? `Downloads · ${downloads.length}`
    : `Downloads · ${activeCount} ativos`;
  clearButton.disabled = finishedCount === 0;
  list.replaceChildren();

  downloads.forEach((download) => {
    const progress = download.status === "done"
      ? 100
      : Math.min(100, Math.max(0, Number(download.progress) || 0));
    const active = ["queued", "in_progress", "transferring", "cancelling"].includes(download.status);
    const preparing = ["ready_for_browser", "retrying"].includes(download.status);
    const retryable = Boolean(download.canRetryTransfer);
    const retryableDownload = download.status === "error" && !retryable;
    const statusText = downloadStatusText(download);

    const item = document.createElement("article");
    item.className = `mh-download-item ${download.status}`;

    const head = document.createElement("div");
    head.className = "mh-download-head";
    const copy = document.createElement("div");
    copy.className = "mh-download-copy";
    const title = document.createElement("div");
    title.className = "mh-download-title";
    title.textContent = download.filename || download.title || "Mídia sem título";
    title.title = title.textContent;
    const source = document.createElement("div");
    source.className = "mh-download-source";
    source.textContent = `${download.source || "site desconhecido"} · ${formatDownloadType(download.format)}`;
    const pct = document.createElement("div");
    pct.className = "mh-download-pct";
    pct.textContent = `${Math.round(progress)}%`;
    copy.append(title, source);
    head.append(copy, pct);

    const progressTrack = document.createElement("div");
    progressTrack.className = "mh-download-progress";
    const bar = document.createElement("div");
    bar.className = "bar";
    bar.style.width = `${progress}%`;
    progressTrack.appendChild(bar);

    const foot = document.createElement("div");
    foot.className = "mh-download-foot";
    const status = document.createElement("div");
    status.className = "mh-download-status";
    status.textContent = statusText;
    status.title = statusText;
    const action = document.createElement("button");
    action.type = "button";
    action.className = "mh-download-action";
    action.textContent = retryableDownload
      ? "Repetir"
      : retryable
      ? "Tentar novamente"
      : preparing
      ? (download.status === "retrying" ? "Repetindo" : "Preparando")
      : active
        ? (download.status === "cancelling" ? "Cancelando" : "Cancelar")
        : "Remover";
    action.disabled = download.status === "cancelling" || preparing;
    action.addEventListener("click", () => {
      const type = retryableDownload
        ? "retryDownload"
        : retryable
          ? "retryTransfer"
          : active
            ? "cancelDownload"
            : "removeDownload";
      sendRuntimeMessage({ type, id: download.id })
        .then((response) => {
          if (!response?.ok) showToast(response?.error || "Ação indisponível");
        })
        .catch((error) => showToast(error.message));
    });
    foot.append(status, action);
    item.append(head, progressTrack, foot);
    list.appendChild(item);
  });
}

function injectInstagramButtons() {
  injectInstagramFeedButtons();

  injectInstagramReels();
}

function getInstagramMediaUrl(container) {
  const scope = container.closest("article") || container;
  const link = scope.querySelector('a[href*="/p/"], a[href*="/reel/"]');
  if (link?.href) return link.href.split("?")[0];
  if (/\/p\/|\/reel\//.test(window.location.pathname)) return window.location.href.split("?")[0];
  return null;
}

function injectInstagramFeedButtons() {
  const sections = document.querySelectorAll("section");

  sections.forEach((section) => {
    if (section.querySelector("[data-media-harvest-instagram]")) {
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

    const mediaUrl = getInstagramMediaUrl(section);
    if (!mediaUrl) return;

    const hdButton = createInstagramButton("hd", mediaUrl);

    const whatsappButton =
      createInstagramButton("whatsapp", mediaUrl);

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
    if (container.querySelector("[data-media-harvest-instagram]")) return;

    const mediaUrl = getInstagramMediaUrl(container);
    if (!mediaUrl) return;

    const hdButton = createInstagramButton("hd", mediaUrl);

    const whatsappButton = createInstagramButton("whatsapp", mediaUrl);

    container.appendChild(hdButton);

    container.appendChild(whatsappButton);
  });
}

function createInstagramButton(type = "hd", mediaUrl = null) {
  const button = document.createElement("div");

  button.setAttribute("data-media-harvest-instagram", "true");
  if (mediaUrl) button.dataset.mediaUrl = mediaUrl;

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
            await startManagedDownload(
              backendUrl,
              tweetUrl,
              locationPath,
              type === "whatsapp" ? "whatsapp" : "twitter"
            );
            showToast("Download adicionado");
          } catch (err) {
            console.error(err);
            showToast(err.message || "Erro ao conectar ao servidor");
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

document.addEventListener(
  "click",
  async (e) => {
    const button = e.target.closest(
      "[data-media-harvest-instagram]"
    );

    if (!button) return;

    e.preventDefault();

    e.stopPropagation();

    const type =
      button.getAttribute("data-download-type");
    const mediaUrl = button.dataset.mediaUrl;

    if (!mediaUrl) {
      showToast("Link da publicação não encontrado");
      return;
    }

    storageGet(
      ["locationPath", "backendUrl"],
      async (result) => {
        const backendUrl = getBackendUrl(result);
        const locationPath = result.locationPath || DEFAULT_DOWNLOAD_PATH;

        try {
          await startManagedDownload(
            backendUrl,
            mediaUrl,
            locationPath,
            type === "whatsapp" ? "whatsapp" : "instagram"
          );
          showToast("Download adicionado");
        } catch (err) {
          showToast(err.message || "Erro ao conectar ao servidor");
        }
      }
    );
  },
  true
);

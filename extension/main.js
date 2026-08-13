const extensionApi = typeof browser !== "undefined" ? browser : chrome;
const DEFAULT_BACKEND_URL = "http://localhost:3000";
const DEFAULT_DOWNLOAD_PATH = "/downloads";

function callApi(method, context, ...args) {
  return new Promise((resolve, reject) => {
    method.call(context, ...args, (result) => {
      const error = extensionApi.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

function sendMessage(message) {
  return callApi(extensionApi.runtime.sendMessage, extensionApi.runtime, message);
}

async function fetchWithTimeout(url, options = {}, timeout = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getSettings() {
  const result = await callApi(
    extensionApi.storage.local.get,
    extensionApi.storage.local,
    ["locationPath", "backendUrl"]
  );
  return {
    backendUrl: (result.backendUrl || DEFAULT_BACKEND_URL).replace(/\/$/, ""),
    locationPath: result.locationPath || DEFAULT_DOWNLOAD_PATH,
  };
}

async function checkServer(backendUrl) {
  const state = document.getElementById("serverState");
  try {
    const response = await fetchWithTimeout(`${backendUrl}/health`);
    if (!response.ok) throw new Error();
    state.textContent = "online";
    state.classList.add("online");
  } catch (_) {
    state.textContent = "offline";
    state.classList.remove("online");
  }
}

function formatType(format) {
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

function renderDownloads(downloads) {
  const list = document.getElementById("downloadList");
  const activeCount = downloads.filter((item) =>
    ["queued", "in_progress", "transferring", "cancelling", "retrying", "ready_for_browser"].includes(item.status)
  ).length;
  document.getElementById("downloadCount").textContent = `${activeCount} ${activeCount === 1 ? "ativo" : "ativos"}`;
  list.replaceChildren();

  if (!downloads.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Nenhum download no histórico.";
    list.appendChild(empty);
    return;
  }

  downloads.forEach((download) => {
    const active = ["queued", "in_progress", "transferring", "cancelling"].includes(download.status);
    const preparing = ["ready_for_browser", "retrying"].includes(download.status);
    const retryable = Boolean(download.canRetryTransfer);
    const progress = download.status === "done"
      ? 100
      : Math.min(100, Math.max(0, Number(download.progress) || 0));
    const item = document.createElement("article");
    item.className = "queue-item";

    const head = document.createElement("div");
    head.className = "queue-head";
    const title = document.createElement("div");
    title.className = "queue-title";
    title.textContent = download.filename || download.title || "Mídia sem título";
    title.title = title.textContent;
    const pct = document.createElement("span");
    pct.className = "queue-pct";
    pct.textContent = `${Math.round(progress)}%`;
    head.append(title, pct);

    const track = document.createElement("div");
    track.className = "queue-progress";
    const bar = document.createElement("div");
    bar.style.width = `${progress}%`;
    track.appendChild(bar);

    const foot = document.createElement("div");
    foot.className = "queue-foot";
    const meta = document.createElement("div");
    meta.className = "queue-meta";
    const size = formatBytes(download.totalBytes || download.bytesDownloaded);
    meta.textContent = [
      download.source || "site",
      formatType(download.format),
      download.status === "error" ? null : (download.message || download.phase),
      size,
      download.speed ? `${download.speed}/s` : null,
    ].filter(Boolean).join(" · ");

    const actions = document.createElement("div");
    actions.className = "queue-actions";

    const transient = ["retrying", "cancelling", "ready_for_browser"].includes(download.status);
    const canRestart = Boolean(download.sourceUrl || download.pageUrl) && !transient;
    if (canRestart) {
      const restart = document.createElement("button");
      restart.className = "queue-action restart";
      restart.textContent = "Reiniciar";
      restart.addEventListener("click", async () => {
        const response = await sendMessage({ type: "restartDownload", id: download.id })
          .catch((error) => ({ ok: false, error: error.message }));
        if (!response?.ok) popupToast(response?.error || "Não foi possível reiniciar");
      });
      actions.appendChild(restart);
    }

    const action = document.createElement("button");
    action.className = "queue-action";
    action.textContent = retryable
      ? "Tentar novamente"
      : preparing
      ? (download.status === "retrying" ? "Repetindo" : "Preparando")
      : active
        ? (download.status === "cancelling" ? "Cancelando" : "Cancelar")
        : "Remover";
    action.disabled = download.status === "cancelling" || preparing;
    action.addEventListener("click", async () => {
      const response = await sendMessage({
        type: retryable ? "retryTransfer" : active ? "cancelDownload" : "removeDownload",
        id: download.id,
      }).catch((error) => ({ ok: false, error: error.message }));
      if (!response?.ok) popupToast(response?.error || "Ação indisponível");
    });
    actions.appendChild(action);

    foot.append(meta, actions);
    item.append(head, track, foot);

    if (download.status === "error" && download.error) {
      const err = document.createElement("p");
      err.className = "queue-error";
      err.textContent = download.error;
      err.title = download.error;
      item.appendChild(err);
    }

    list.appendChild(item);
  });
}

async function startDownload(event) {
  const format = event.currentTarget?.id;
  if (!format) {
    popupToast("Formato de download inválido");
    return;
  }

  const buttons = document.querySelectorAll(".downloadButton");
  buttons.forEach((button) => { button.disabled = true; });

  try {
    const [tab] = await callApi(extensionApi.tabs.query, extensionApi.tabs, {
      active: true,
      currentWindow: true,
    });
    if (!tab?.url || !/^https?:/.test(tab.url)) throw new Error("Abra uma página com vídeo primeiro");

    const settings = await getSettings();
    const response = await sendMessage({
      type: "startDownload",
      backendUrl: settings.backendUrl,
      payload: {
        url: tab.url,
        path: settings.locationPath,
        download: format,
      },
      meta: {
        title: tab.title || "Mídia sem título",
        pageUrl: tab.url,
        source: new URL(tab.url).hostname,
        userAgent: navigator.userAgent,
      },
    });

    if (!response?.ok) throw new Error(response?.error || "Servidor recusou o download");
    popupToast("Download adicionado");
  } catch (error) {
    popupToast(error.message || "Não foi possível iniciar");
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function saveBackendUrl() {
  const input = document.getElementById("backendUrlInput");
  let backendUrl;

  try {
    const parsed = new URL(input.value.trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
    backendUrl = parsed.origin;
  } catch (_) {
    popupToast("Use uma URL iniciada por http:// ou https://");
    return;
  }

  try {
    await callApi(extensionApi.storage.local.set, extensionApi.storage.local, { backendUrl });
    input.value = backendUrl;
    checkServer(backendUrl);
    popupToast("Servidor salvo");
  } catch (error) {
    popupToast(error.message || "Não foi possível salvar");
  }
}

async function savePath() {
  try {
    const locationPath = document.getElementById("folderPathInput").value.trim();
    if (locationPath) {
      await callApi(extensionApi.storage.local.set, extensionApi.storage.local, { locationPath });
    } else {
      await callApi(extensionApi.storage.local.remove, extensionApi.storage.local, "locationPath");
    }
    popupToast("Pasta salva");
  } catch (error) {
    popupToast(error.message || "Não foi possível salvar");
  }
}

async function resetPath() {
  try {
    await callApi(extensionApi.storage.local.remove, extensionApi.storage.local, "locationPath");
    document.getElementById("folderPathInput").value = "";
    popupToast("Usando a pasta padrão");
  } catch (error) {
    popupToast(error.message || "Não foi possível alterar a pasta");
  }
}

async function openFolder() {
  try {
    const settings = await getSettings();
    const response = await fetchWithTimeout(`${settings.backendUrl}/open`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: settings.locationPath }),
    });
    if (!response.ok) throw new Error(await response.text());
    popupToast("Pasta aberta");
  } catch (error) {
    popupToast(error.message || "O servidor não pode abrir a pasta");
  }
}

async function loadWorkers() {
  try {
    const settings = await getSettings();
    const response = await fetchWithTimeout(`${settings.backendUrl}/settings`);
    if (!response.ok) throw new Error();
    const data = await response.json();
    const input = document.getElementById("workersInput");
    input.value = data.maxConcurrentDownloads || 1;
    if (data.maxWorkersLimit) input.max = data.maxWorkersLimit;
  } catch (_) {
    // servidor offline: mantém o placeholder
  }
}

async function saveWorkers() {
  const input = document.getElementById("workersInput");
  const value = Math.max(1, Math.min(8, Math.floor(Number(input.value) || 1)));
  try {
    const settings = await getSettings();
    const response = await fetchWithTimeout(`${settings.backendUrl}/settings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxConcurrentDownloads: value }),
    });
    if (!response.ok) throw new Error(await response.text());
    const data = await response.json();
    input.value = data.maxConcurrentDownloads;
    popupToast(`Downloads simultâneos: ${data.maxConcurrentDownloads}`);
  } catch (error) {
    popupToast(error.message || "Não foi possível salvar");
  }
}

async function loadCookies() {
  const result = await callApi(
    extensionApi.storage.local.get,
    extensionApi.storage.local,
    ["cookiesTxt"]
  );
  document.getElementById("cookiesInput").value = result.cookiesTxt || "";
}

async function saveCookies() {
  const value = document.getElementById("cookiesInput").value.trim();
  try {
    if (value) {
      await callApi(extensionApi.storage.local.set, extensionApi.storage.local, { cookiesTxt: value });
      popupToast("Cookies salvos");
    } else {
      await callApi(extensionApi.storage.local.remove, extensionApi.storage.local, "cookiesTxt");
      popupToast("Cookies vazios · removidos");
    }
  } catch (error) {
    popupToast(error.message || "Não foi possível salvar os cookies");
  }
}

async function clearCookies() {
  try {
    await callApi(extensionApi.storage.local.remove, extensionApi.storage.local, "cookiesTxt");
    document.getElementById("cookiesInput").value = "";
    popupToast("Cookies removidos");
  } catch (error) {
    popupToast(error.message || "Não foi possível remover os cookies");
  }
}

async function loadVideoButtonToggle() {
  const result = await callApi(
    extensionApi.storage.local.get,
    extensionApi.storage.local,
    ["showVideoButton"]
  );
  document.getElementById("toggleVideoButton").checked = result.showVideoButton !== false;
}

async function saveVideoButtonToggle(event) {
  const enabled = event.currentTarget.checked;
  try {
    await callApi(extensionApi.storage.local.set, extensionApi.storage.local, {
      showVideoButton: enabled,
    });
    popupToast(enabled ? "Botão nos vídeos ativado" : "Botão nos vídeos desativado");
  } catch (error) {
    popupToast(error.message || "Não foi possível salvar");
  }
}

async function loadPageButtonToggle() {
  const result = await callApi(
    extensionApi.storage.local.get,
    extensionApi.storage.local,
    ["showPageButton"]
  );
  document.getElementById("togglePageButton").checked = result.showPageButton !== false;
}

async function savePageButtonToggle(event) {
  const enabled = event.currentTarget.checked;
  try {
    await callApi(extensionApi.storage.local.set, extensionApi.storage.local, {
      showPageButton: enabled,
    });
    popupToast(enabled ? "Botão na página ativado" : "Botão na página desativado");
  } catch (error) {
    popupToast(error.message || "Não foi possível salvar");
  }
}

let toastTimer;
function popupToast(message) {
  const alert = document.getElementById("alert");
  document.getElementById("status").textContent = message;
  alert.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => alert.classList.remove("show"), 2200);
}

document.querySelectorAll(".downloadButton").forEach((button) => {
  button.addEventListener("click", startDownload);
});
document.getElementById("backendUrlButton").addEventListener("click", saveBackendUrl);
document.getElementById("submitButton").addEventListener("click", savePath);
document.getElementById("deletePath").addEventListener("click", resetPath);
document.getElementById("openFolder").addEventListener("click", openFolder);
document.getElementById("toggleVideoButton").addEventListener("change", saveVideoButtonToggle);
document.getElementById("togglePageButton").addEventListener("change", savePageButtonToggle);
document.getElementById("saveWorkers").addEventListener("click", saveWorkers);
document.getElementById("saveCookies").addEventListener("click", saveCookies);
document.getElementById("clearCookies").addEventListener("click", clearCookies);

extensionApi.runtime.onMessage.addListener((message) => {
  if (message?.type === "downloadsUpdated") renderDownloads(message.downloads || []);
});

document.addEventListener("DOMContentLoaded", async () => {
  try {
    const settings = await getSettings();
    document.getElementById("backendUrlInput").value = settings.backendUrl;
    document.getElementById("folderPathInput").value = settings.locationPath === DEFAULT_DOWNLOAD_PATH
      ? ""
      : settings.locationPath;
    checkServer(settings.backendUrl);
    await loadVideoButtonToggle();
    await loadPageButtonToggle();
    await loadWorkers();
    await loadCookies();
    const response = await sendMessage({ type: "getDownloads" }).catch(() => null);
    renderDownloads(response?.downloads || []);
  } catch (error) {
    popupToast(error.message || "Não foi possível carregar a extensão");
  }
});

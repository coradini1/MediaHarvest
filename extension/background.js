const extensionApi = typeof browser !== "undefined" ? browser : chrome;
const DOWNLOADS_STORAGE_KEY = "mediaHarvestDownloads";
const DEFAULT_DOWNLOAD_PATH = "/downloads";
const POLL_INTERVAL = 2000;
const ACTIVE_STATUSES = new Set(["queued", "in_progress", "cancelling"]);
const downloads = new Map();
const pollTimers = new Map();
const browserTransferTimers = new Map();
const browserTransferGenerations = new Map();
const startedBrowserDownloads = new Set();
const pendingDownloads = new Set();
let persistenceQueue = Promise.resolve();

function callApi(method, context, ...args) {
  return new Promise((resolve, reject) => {
    method.call(context, ...args, (result) => {
      const error = extensionApi.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(result);
    });
  });
}

async function getStoredCookies() {
  try {
    const result = await callApi(
      extensionApi.storage.local.get,
      extensionApi.storage.local,
      ["cookiesTxt"]
    );
    const value = (result.cookiesTxt || "").trim();
    return value || undefined;
  } catch (_) {
    return undefined;
  }
}

async function persistDownloads() {
  const value = [...downloads.values()];
  persistenceQueue = persistenceQueue
    .catch(() => {})
    .then(() => callApi(
      extensionApi.storage.local.set,
      extensionApi.storage.local,
      { [DOWNLOADS_STORAGE_KEY]: value }
    ));
  await persistenceQueue.catch(() => {});
}

async function fetchWithTimeout(url, options = {}, timeout = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error.name === "AbortError") throw new Error("O servidor demorou demais para responder");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function publicDownloads() {
  return [...downloads.values()].sort((a, b) => b.createdAt - a.createdAt);
}

async function broadcastDownloads() {
  await persistDownloads();

  extensionApi.runtime.sendMessage(
    { type: "downloadsUpdated", downloads: publicDownloads() },
    () => extensionApi.runtime.lastError
  );

  const tabs = await callApi(extensionApi.tabs.query, extensionApi.tabs, {}).catch(() => []);
  tabs.forEach((tab) => {
    if (!tab.id) return;
    extensionApi.tabs.sendMessage(
      tab.id,
      { type: "downloadsUpdated", downloads: publicDownloads() },
      () => extensionApi.runtime.lastError
    );
  });
}

function downloadFile(item) {
  if (startedBrowserDownloads.has(item.id)) return;
  startedBrowserDownloads.add(item.id);
  item.canRetryTransfer = false;

  extensionApi.downloads.download({
    url: `${item.backendUrl}/file/${item.id}`,
    saveAs: false,
  }, (browserDownloadId) => {
    const error = extensionApi.runtime.lastError;
    if (error) {
      startedBrowserDownloads.delete(item.id);
      item.status = "error";
      item.progress = 0;
      item.canRetryTransfer = true;
      item.error = `Arquivo pronto, mas o navegador não iniciou o download: ${error.message}`;
      broadcastDownloads();
      return;
    }

    item.browserDownloadId = browserDownloadId;
    item.status = "transferring";
    item.phase = "Transferindo ao navegador";
    item.progress = 0;
    item.bytesDownloaded = null;
    item.message = "Transferindo do servidor para o navegador...";
    item.updatedAt = Date.now();
    broadcastDownloads();
    updateBrowserDownload(browserDownloadId);
  });
}

function updateBrowserDownload(browserDownloadId) {
  clearTimeout(browserTransferTimers.get(browserDownloadId));
  const generation = (browserTransferGenerations.get(browserDownloadId) || 0) + 1;
  browserTransferGenerations.set(browserDownloadId, generation);

  extensionApi.downloads.search({ id: browserDownloadId }, (results) => {
    if (browserTransferGenerations.get(browserDownloadId) !== generation) return;

    const item = [...downloads.values()].find((entry) => entry.browserDownloadId === browserDownloadId);
    if (!item) return;

    if (extensionApi.runtime.lastError || !results?.length) {
      item.transferLookupErrors = (item.transferLookupErrors || 0) + 1;
      if (item.transferLookupErrors >= 5) {
        item.status = "error";
        item.error = "O navegador perdeu o acompanhamento desta transferência.";
        item.message = item.error;
        broadcastDownloads();
        return;
      }
      browserTransferTimers.set(
        browserDownloadId,
        setTimeout(() => updateBrowserDownload(browserDownloadId), 2000)
      );
      return;
    }

    item.transferLookupErrors = 0;
    const browserDownload = results[0];

    item.bytesDownloaded = browserDownload.bytesReceived > 0 ? browserDownload.bytesReceived : null;
    item.totalBytes = browserDownload.totalBytes > 0 ? browserDownload.totalBytes : item.totalBytes;
    item.progress = item.totalBytes && item.bytesDownloaded
      ? Math.min(99, Math.round((item.bytesDownloaded / item.totalBytes) * 100))
      : 0;
    item.updatedAt = Date.now();

    if (browserDownload.state === "complete") {
      browserTransferTimers.delete(browserDownloadId);
      browserTransferGenerations.delete(browserDownloadId);
      item.status = "done";
      item.phase = "Concluído";
      item.progress = 100;
      item.message = "Salvo no navegador";
      item.backendReady = false;
      item.canRetryTransfer = false;
    } else if (browserDownload.state === "interrupted") {
      browserTransferTimers.delete(browserDownloadId);
      browserTransferGenerations.delete(browserDownloadId);
      item.status = browserDownload.error === "USER_CANCELED" ? "cancelled" : "error";
      item.phase = browserDownload.error === "USER_CANCELED" ? "Cancelado" : "Erro";
      item.error = browserDownload.error === "USER_CANCELED"
        ? null
        : `Transferência interrompida: ${browserDownload.error || "erro desconhecido"}`;
      item.message = browserDownload.error === "USER_CANCELED" ? "Transferência cancelada" : item.error;
      item.canRetryTransfer = browserDownload.error !== "USER_CANCELED";
    } else {
      item.status = "transferring";
      item.phase = "Transferindo ao navegador";
      item.message = "Transferindo do servidor para o navegador...";
      browserTransferTimers.set(
        browserDownloadId,
        setTimeout(() => updateBrowserDownload(browserDownloadId), 1000)
      );
    }

    broadcastDownloads();
  });
}

extensionApi.downloads.onChanged.addListener((delta) => {
  if ([...downloads.values()].some((item) => item.browserDownloadId === delta.id)) {
    updateBrowserDownload(delta.id);
  }
});

function schedulePoll(id, delay = POLL_INTERVAL) {
  clearTimeout(pollTimers.get(id));
  pollTimers.set(id, setTimeout(() => {
    pollTimers.delete(id);
    pollDownload(id);
  }, delay));
}

async function pollDownload(id) {
  const item = downloads.get(id);
  if (!item || !ACTIVE_STATUSES.has(item.status)) return;

  try {
    const response = await fetchWithTimeout(`${item.backendUrl}/status/${id}`, {}, 10000);
    if (response.status === 404) {
      item.status = "error";
      item.error = "O servidor foi reiniciado e perdeu este download. Inicie-o novamente.";
      item.message = item.error;
      item.updatedAt = Date.now();
      await broadcastDownloads();
      return;
    }
    if (!response.ok) throw new Error(`Status indisponível (${response.status})`);

    const data = await response.json();
    const serverBytesDownloaded = Number(data.bytesDownloaded);
    const serverTotalBytes = Number(data.totalBytes);
    Object.assign(item, {
      status: data.status || "in_progress",
      progress: Number.isFinite(Number(data.progress)) ? Number(data.progress) : item.progress,
      filename: data.filename || item.filename,
      message: data.message || null,
      error: data.error || null,
      phase: data.phase || item.phase || null,
      bytesDownloaded: serverBytesDownloaded > 0 ? serverBytesDownloaded : null,
      totalBytes: serverTotalBytes > 0 ? serverTotalBytes : null,
      speed: data.speed ?? item.speed ?? null,
      eta: data.eta ?? item.eta ?? null,
      processingProgress: data.processingProgress ?? null,
      updatedAt: Date.now(),
    });
    item.connectionErrors = 0;
    await broadcastDownloads();

    if (item.status === "done") {
      item.backendReady = true;
      item.status = "ready_for_browser";
      item.progress = 100;
      item.phase = "Preparando transferência";
      item.message = "Preparando transferência...";
      await broadcastDownloads();
      downloadFile(item);
      return;
    }

    if (item.status !== "error" && item.status !== "cancelled") schedulePoll(id);
  } catch (error) {
    item.connectionErrors = (item.connectionErrors || 0) + 1;
    item.message = "Reconectando ao servidor...";
    item.updatedAt = Date.now();
    await broadcastDownloads();
    schedulePoll(id, Math.min(10000, POLL_INTERVAL * item.connectionErrors));
  }
}

async function startDownload(message, sender) {
  const backendUrl = new URL(message.backendUrl).origin;
  const key = `${backendUrl}|${message.payload.url}|${message.payload.download || "original"}`;
  const existing = [...downloads.values()].find((item) =>
    item.backendUrl === backendUrl
      && item.pageUrl === message.payload.url
      && item.format === (message.payload.download || "original")
      && [...ACTIVE_STATUSES, "ready_for_browser", "transferring"].includes(item.status)
  );

  if (existing) return existing;
  if (pendingDownloads.has(key)) throw new Error("Este download já está sendo adicionado");
  pendingDownloads.add(key);

  try {
    const cookies = await getStoredCookies();
    const payload = {
      ...message.payload,
      title: message.payload.title || message.meta?.title || null,
      cookies,
      userAgent: message.meta?.userAgent || undefined,
    };
    const response = await fetchWithTimeout(backendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }, 20000);

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(detail || `Servidor respondeu ${response.status}`);
    }

    const data = await response.json();
    if (!data.id) throw new Error("Servidor não retornou o ID do download");

    const item = {
      id: data.id,
      backendUrl,
      status: "in_progress",
      progress: 0,
      filename: data.filename || null,
      title: message.meta?.title || "Mídia sem título",
      pageUrl: message.meta?.pageUrl || message.payload.url,
      sourceUrl: message.payload.url,
      downloadPath: message.payload.path || DEFAULT_DOWNLOAD_PATH,
      source: message.meta?.source || new URL(message.payload.url).hostname,
      format: message.payload.download || "original",
      tabId: sender.tab?.id || null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      message: "Aguardando o servidor...",
      error: null,
    };

    downloads.set(item.id, item);
    await broadcastDownloads();
    schedulePoll(item.id, 500);
    return item;
  } finally {
    pendingDownloads.delete(key);
  }
}

async function cancelDownload(id) {
  const item = downloads.get(id);
  if (!item || !["queued", "in_progress", "transferring"].includes(item.status)) {
    throw new Error("Este download não pode mais ser cancelado");
  }

  if (item.status === "transferring" && item.browserDownloadId) {
    clearTimeout(browserTransferTimers.get(item.browserDownloadId));
    browserTransferGenerations.set(
      item.browserDownloadId,
      (browserTransferGenerations.get(item.browserDownloadId) || 0) + 1
    );
    await callApi(
      extensionApi.downloads.cancel,
      extensionApi.downloads,
      item.browserDownloadId
    );
    item.status = "cancelled";
    item.message = "Transferência cancelada";
    item.updatedAt = Date.now();
    await broadcastDownloads();
    return item;
  }

  const previousStatus = item.status;
  item.status = "cancelling";
  item.message = "Solicitando cancelamento...";
  await broadcastDownloads();

  try {
    const response = await fetchWithTimeout(
      `${item.backendUrl}/downloads/${id}`,
      { method: "DELETE" },
      10000
    );
    if (!response.ok) {
      if (response.status === 404 || response.status === 405 || response.status === 501) {
        throw new Error("O servidor ainda não oferece cancelamento");
      }
      throw new Error(`Não foi possível cancelar (${response.status})`);
    }

    item.status = "cancelled";
    item.message = "Download cancelado";
    item.updatedAt = Date.now();
    clearTimeout(pollTimers.get(id));
    await broadcastDownloads();
    return item;
  } catch (error) {
    item.status = previousStatus;
    item.message = error.message;
    await broadcastDownloads();
    schedulePoll(id);
    throw error;
  }
}

async function removeDownload(id) {
  const item = downloads.get(id);
  if (!item || ["queued", "in_progress", "transferring", "cancelling", "retrying"].includes(item.status)) return;
  downloads.delete(id);
  clearTimeout(pollTimers.get(id));
  pollTimers.delete(id);
  startedBrowserDownloads.delete(id);
  if (item.browserDownloadId) {
    clearTimeout(browserTransferTimers.get(item.browserDownloadId));
    browserTransferTimers.delete(item.browserDownloadId);
    browserTransferGenerations.delete(item.browserDownloadId);
  }
  await broadcastDownloads();
}

async function clearFinishedDownloads() {
  downloads.forEach((item, id) => {
    if (!["queued", "in_progress", "transferring", "cancelling", "retrying", "ready_for_browser"].includes(item.status)) {
      downloads.delete(id);
      startedBrowserDownloads.delete(id);
    }
  });
  await broadcastDownloads();
}

async function retryTransfer(id) {
  const item = downloads.get(id);
  if (!item?.backendReady || !item.canRetryTransfer) {
    throw new Error("Esta transferência não pode ser reiniciada");
  }

  startedBrowserDownloads.delete(id);
  item.browserDownloadId = null;
  item.status = "ready_for_browser";
  item.progress = 100;
  item.error = null;
  item.message = "Preparando nova tentativa...";
  await broadcastDownloads();
  downloadFile(item);
}

async function retryDownload(id) {
  const item = downloads.get(id);
  if (!item || item.status !== "error" || item.canRetryTransfer) {
    throw new Error("Este download não pode ser repetido");
  }

  const sourceUrl = item.sourceUrl || item.pageUrl;
  if (!sourceUrl) throw new Error("A URL original deste download não está disponível");

  item.status = "retrying";
  item.message = "Adicionando nova tentativa...";
  item.error = null;
  await broadcastDownloads();

  try {
    const replacement = await startDownload({
      backendUrl: item.backendUrl,
      payload: {
        url: sourceUrl,
        path: item.downloadPath || DEFAULT_DOWNLOAD_PATH,
        download: item.format || "original",
        title: item.title || null,
      },
      meta: {
        title: item.title,
        pageUrl: item.pageUrl || sourceUrl,
        source: item.source,
      },
    }, { tab: { id: item.tabId } });

    if (replacement.id !== id) downloads.delete(id);
    await broadcastDownloads();
    return replacement;
  } catch (error) {
    item.status = "error";
    item.error = error.message;
    item.message = error.message;
    await broadcastDownloads();
    throw error;
  }
}

async function restartDownload(id) {
  const item = downloads.get(id);
  if (!item) throw new Error("Download não encontrado");

  const sourceUrl = item.sourceUrl || item.pageUrl;
  if (!sourceUrl) throw new Error("A URL original deste download não está disponível");

  if (["queued", "in_progress", "transferring", "cancelling"].includes(item.status)) {
    await cancelDownload(id).catch(() => {});
  }

  const snapshot = {
    backendUrl: item.backendUrl,
    downloadPath: item.downloadPath,
    format: item.format,
    title: item.title,
    pageUrl: item.pageUrl,
    source: item.source,
    tabId: item.tabId,
  };

  item.status = "retrying";
  item.message = "Reiniciando...";
  item.error = null;
  clearTimeout(pollTimers.get(id));
  await broadcastDownloads();

  try {
    const replacement = await startDownload({
      backendUrl: snapshot.backendUrl,
      payload: {
        url: sourceUrl,
        path: snapshot.downloadPath || DEFAULT_DOWNLOAD_PATH,
        download: snapshot.format || "original",
        title: snapshot.title || null,
      },
      meta: {
        title: snapshot.title,
        pageUrl: snapshot.pageUrl || sourceUrl,
        source: snapshot.source,
      },
    }, { tab: { id: snapshot.tabId } });

    if (replacement.id !== id) downloads.delete(id);
    await broadcastDownloads();
    return replacement;
  } catch (error) {
    item.status = "error";
    item.error = error.message;
    item.message = error.message;
    await broadcastDownloads();
    throw error;
  }
}

const initialization = callApi(
  extensionApi.storage.local.get,
  extensionApi.storage.local,
  [DOWNLOADS_STORAGE_KEY]
).then((result) => {
  const saved = result[DOWNLOADS_STORAGE_KEY] || [];
  saved.forEach((item) => {
    downloads.set(item.id, item);
    if (ACTIVE_STATUSES.has(item.status)) schedulePoll(item.id, 500);
    if (item.status === "ready_for_browser") downloadFile(item);
    if (item.status === "transferring" && item.browserDownloadId) {
      updateBrowserDownload(item.browserDownloadId);
    }
  });
}).catch(() => {});

if (extensionApi.alarms) {
  extensionApi.alarms.create("mediaHarvestReconcile", { periodInMinutes: 0.5 });
  extensionApi.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name !== "mediaHarvestReconcile") return;
    initialization.then(() => {
      downloads.forEach((item) => {
        if (ACTIVE_STATUSES.has(item.status)) schedulePoll(item.id, 0);
        if (item.status === "ready_for_browser") downloadFile(item);
        if (item.status === "transferring" && item.browserDownloadId) {
          updateBrowserDownload(item.browserDownloadId);
        }
      });
    });
  });
}

extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return false;

  if (message.type === "startDownload" && message.backendUrl && message.payload) {
    initialization.then(() => startDownload(message, sender))
      .then((download) => sendResponse({ ok: true, download }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "getDownloads") {
    initialization.then(() => sendResponse({ ok: true, downloads: publicDownloads() }));
    return true;
  }

  if (message.type === "cancelDownload" && message.id) {
    initialization.then(() => cancelDownload(message.id))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "removeDownload" && message.id) {
    initialization.then(() => removeDownload(message.id)).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.type === "retryTransfer" && message.id) {
    initialization.then(() => retryTransfer(message.id))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "retryDownload" && message.id) {
    initialization.then(() => retryDownload(message.id))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "restartDownload" && message.id) {
    initialization.then(() => restartDownload(message.id))
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "clearFinishedDownloads") {
    initialization.then(clearFinishedDownloads).then(() => sendResponse({ ok: true }));
    return true;
  }

  return false;
});

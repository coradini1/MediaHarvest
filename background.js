const extensionApi = typeof browser !== "undefined" ? browser : chrome;
const watchedDownloads = new Set();

function downloadUrl(url, sendResponse) {
  extensionApi.downloads.download({ url }, (downloadId) => {
    const error = extensionApi.runtime.lastError;

    if (error) {
      if (sendResponse) sendResponse({ ok: false, error: error.message });
      return;
    }

    if (sendResponse) sendResponse({ ok: true, downloadId });
  });
}

function notifyTab(tabId, message) {
  if (!tabId || !extensionApi.tabs || !extensionApi.tabs.sendMessage) return;

  extensionApi.tabs.sendMessage(tabId, message, () => {
    extensionApi.runtime.lastError;
  });
}

function watchBackendDownload(backendUrl, id, tabId) {
  const key = `${backendUrl}/status/${id}`;

  if (watchedDownloads.has(key)) return;

  watchedDownloads.add(key);

  const poll = () => {
    fetch(`${backendUrl}/status/${id}`)
      .then((response) => {
        if (!response.ok) throw new Error("Status não encontrado");
        return response.json();
      })
      .then((data) => {
        if (data.status === "done") {
          watchedDownloads.delete(key);
          notifyTab(tabId, {
            type: "backendDownloadDone",
            id,
            filename: data.filename || null,
          });
          downloadUrl(`${backendUrl}/file/${id}`);
          return;
        }

        if (data.status === "error") {
          watchedDownloads.delete(key);
          notifyTab(tabId, {
            type: "backendDownloadError",
            id,
            error: data.error || data.message || "Erro no download",
          });
          console.error("MediaHarvest download error", data.error || data.message || data);
          return;
        }

        setTimeout(poll, 2000);
      })
      .catch((error) => {
        console.error("MediaHarvest status error", error);
        setTimeout(poll, 5000);
      });
  };

  setTimeout(poll, 1000);
}

extensionApi.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === "downloadFromBackend" && message.url) {
    downloadUrl(message.url, sendResponse);
    return true;
  }

  if (message.type === "watchBackendDownload" && message.backendUrl && message.id) {
    watchBackendDownload(
      message.backendUrl.replace(/\/$/, ""),
      message.id,
      sender.tab && sender.tab.id
    );
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

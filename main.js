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

function storageSet(value) {
  return extensionApi.storage.local.set(value);
}

function storageRemove(key) {
  return extensionApi.storage.local.remove(key);
}

function getBackendUrl(callback) {
  storageGet(["backendUrl"], (result) => {
    callback((result.backendUrl || DEFAULT_BACKEND_URL).replace(/\/$/, ""));
  });
}

function downloadFromBackend(backendUrl, id) {
  const url = `${backendUrl}/file/${id}`;

  if (extensionApi.downloads && extensionApi.downloads.download) {
    extensionApi.downloads.download({ url });
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

function queryTabs(query, callback) {
  const result = extensionApi.tabs.query(query);

  if (result && typeof result.then === "function") {
    result.then(callback);
    return;
  }

  extensionApi.tabs.query(query, callback);
}

document.addEventListener("DOMContentLoaded", function () {
  storageGet(["locationPath", "backendUrl"], (result) => {
    const locationPath = result.locationPath;
    const backendUrl = result.backendUrl || DEFAULT_BACKEND_URL;

    document.getElementById("backendUrlInput").value = backendUrl;

    if (locationPath) {
      document.getElementById("folderPathInput").value = locationPath;
    }

    enableDownloadButtons();
  });
});

document.getElementById("original").addEventListener("click", getVideo);

document.getElementById("openFolder").addEventListener("click", openFolder);

document.getElementById("whatsapp").addEventListener("click", getVideo);

document.getElementById("mp3").addEventListener("click", getVideo);

document.getElementById("submitButton").addEventListener("click", folderPath);
document.getElementById("backendUrlButton").addEventListener("click", backendUrl);

document.getElementById("deletePath").addEventListener("click", deletePath);

function folderPath() {
  const locationPath = document
    .getElementById("folderPathInput")
    .value.trim();

  if (locationPath) {
    storageSet({
      locationPath: locationPath,
    });

    enableDownloadButtons();
  } else {
    enableDownloadButtons();
  }
}

function deletePath() {
  storageRemove("locationPath");

  document.getElementById("folderPathInput").value = "";

  enableDownloadButtons();
}

function enableDownloadButtons() {
  document.querySelectorAll("#whatsapp, #mp3, #original").forEach((button) => {
    button.disabled = false;
  });
}

function backendUrl() {
  const backendUrl = document
    .getElementById("backendUrlInput")
    .value.trim()
    .replace(/\/$/, "");

  if (!backendUrl) {
    popupToast("Informe a URL do servidor.");
    return;
  }

  storageSet({ backendUrl });
  popupToast("Servidor configurado!", 1500);
}

function disableDownloadButtons() {
  document.querySelectorAll("#whatsapp, #mp3, #original").forEach((button) => {
    button.disabled = true;
  });
}

function openFolder() {
  storageGet(["locationPath"], (result) => {
    const locationPath = result.locationPath;

    if (locationPath) {
      getBackendUrl((backendUrl) => {
        fetch(`${backendUrl}/open`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            path: locationPath,
          }),
        }).then(() => {
        document.getElementById("status").innerText =
          "Pasta Aberta!";

        document.getElementById("alert").classList.add("show");

        setTimeout(() => {
          document
            .getElementById("alert")
            .classList.remove("show");
        }, 1500);
        });
      });
    }
  });
}

function getVideo() {
  storageGet(["locationPath"], (result) => {
    const locationPath = result.locationPath || DEFAULT_DOWNLOAD_PATH;

    const format = this.id;

    queryTabs({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs[0].url;

      getBackendUrl((backendUrl) => {
        fetch(backendUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            url: url,
            path: locationPath,
            download: format,
          }),
        })
        .then((response) => response.json())
        .then((data) => {
          const id = data && data.id;

          popupToast("Download Iniciado!", 1500);

          if (id) {
            watchBackendDownload(backendUrl, id);
            pollStatus(backendUrl, id, (status) => {
              if (status === "done") {
                popupToast("Download Pronto!", 2500, true);
              } else if (status === "error") {
                  popupToast("Erro no download");
              }
            });
          }
        })
        .catch((err) => {
          console.error(err);
            popupToast("Erro ao iniciar download");
        });
      });
    });
  });
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
        if (data.status === "done") {
          clearInterval(interval);
          cb("done");
        } else if (data.status === "error") {
          clearInterval(interval);
          cb("error");
        }
      })
      .catch((err) => {
        // ignore transient errors, but stop after some time? keep simple for now
        console.error(err);
      });
  }, 2000);
}

function popupToast(message, duration = 1500, large = false) {
  const statusEl = document.getElementById("status");
  const alertEl = document.getElementById("alert");

  if (statusEl) {
    statusEl.innerText = message;
    if (large) {
      statusEl.style.fontSize = "16px";
      statusEl.style.fontWeight = "600";
    }
  }

  if (alertEl) {
    alertEl.classList.add("show");
    setTimeout(() => {
      alertEl.classList.remove("show");
      if (statusEl && large) {
        // revert styles
        statusEl.style.fontSize = "";
        statusEl.style.fontWeight = "";
      }
    }, duration);
  }
}

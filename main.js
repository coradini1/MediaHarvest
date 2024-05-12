

document.addEventListener("DOMContentLoaded", function () {
  const locationPath = localStorage.getItem("locationPath");
  if (locationPath) {
    enableDownloadButtons();
  } else {
    disableDownloadButtons();
  }
});

document.getElementById("original").addEventListener("click", getVideo);

document.getElementById("openFolder").addEventListener("click", openFolder);

document.getElementById("whatsapp").addEventListener("click", getVideo);

document.getElementById("mp3").addEventListener("click", getVideo);

document.getElementById("submitButton").addEventListener("click", folderPath);

document.getElementById("folderPathInput").value =
  localStorage.getItem("locationPath");

document.getElementById("deletePath").addEventListener("click", deletePath);

function folderPath() {
  const locationPath = document.getElementById("folderPathInput").value.trim();
  if (locationPath) {
    localStorage.setItem("locationPath", locationPath);
    enableDownloadButtons();
  } else {
    console.error("Por favor insira um caminho válido.");
    disableDownloadButtons();
  }
}

function deletePath() {
  localStorage.removeItem("locationPath");
  document.getElementById("folderPathInput").value = "";
  disableDownloadButtons();
}

function enableDownloadButtons() {
  document.querySelectorAll("#whatsapp, #mp4, #original").forEach((button) => {
    button.disabled = false;
  });
}

function disableDownloadButtons() {
  document.querySelectorAll("#whatsapp, #mp4, #original").forEach((button) => {
    button.disabled = true;
  });
}

function openFolder() {
  const locationPath = localStorage.getItem("locationPath");
  console.log(locationPath);
  if (locationPath) {
    fetch("http://localhost:3000/open", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        path: locationPath,
      }),
    }).then((res) => {
      document.getElementById("status").innerText = "Pasta Aberta!";
      document.getElementById("alert").classList.add("show");
      setTimeout(() => {
        document.getElementById("alert").classList.remove("show");
      }, 1500);
    });
  }
}

function getVideo(event) {
  if (localStorage.getItem("locationPath") === null) {
    alert("Por favor insira um caminho válido.");
    return;
  }
  let url = "";
  let format = this.id;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    url = tab.url;

    if (true) {
      fetch("http://localhost:3000", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: url,
          path: localStorage.getItem("locationPath"),
          download: format,
        }),
      }).then((res) => {
        document.getElementById("status").innerText = "Download Pronto!";
        document.getElementById("alert").classList.add("show");
        setTimeout(() => {
          document.getElementById("alert").classList.remove("show");
        }, 1500);
      });
    }
  });
}

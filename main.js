
const supportedSites = [
  "youtube.com",
  "facebook.com",
  "twitter.com",
  "instagram.com",
  "tiktok.com",
  "reddit.com",
];

document
  .getElementById("downloadButton")
  .addEventListener("click", getVideo);
document.getElementById("submitButton").addEventListener("click", folderPath);

document.getElementById("folderPathInput").value = localStorage.getItem("locationPath");

function folderPath() {
  const locationPath = document.getElementById("folderPathInput").value.trim();
  if (locationPath) {
    localStorage.setItem("locationPath", locationPath);
  } else {
    console.error("Por favor insira um caminho válido.");
  }
}

function getVideo() {
  if(localStorage.getItem("locationPath") === null) {
    alert("Por favor insira um caminho válido.");
    return;
  }
  let url = "";
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs[0];
    url = tab.url;
    const isSupported = supportedSites.some((site) => url.includes(site));
    
    if (isSupported) {
      fetch("http://localhost:3000", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: url,
          path: localStorage.getItem("locationPath"),
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

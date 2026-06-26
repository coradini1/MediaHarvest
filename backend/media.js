const express = require("express");
const { spawn } = require("child_process");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(
  cors({
    origin: true,
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));

const downloads = {};
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR;
const YT_DLP_PATH = process.env.YT_DLP_PATH || "yt-dlp";

const resolveDownloadLocation = (requestedPath) => DOWNLOAD_DIR || requestedPath;

app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} ${req.method} ${req.url}`);
  next();
});

const findDownloadedFile = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const found = findDownloadedFile(fullPath);
      if (found) return found;
    } else if (!entry.name.endsWith(".part") && !entry.name.endsWith(".ytdl")) {
      return fullPath;
    }
  }

  return null;
};

const cleanupDownload = (id) => {
  const item = downloads[id];

  if (!item || !item.workDir) return;

  fs.rm(item.workDir, { recursive: true, force: true }, () => {
    delete downloads[id];
  });
};

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

const executeYtDlp = (id, format, location, url) => {
  let args;

  if (format === "mp3") {
    args = [
      "--extract-audio",
      "--audio-format",
      "mp3",
      "--embed-thumbnail",
      "--add-metadata",
      "-x",
      "--no-playlist",
      "-o",
      `${location}/%(title)s.%(ext)s`,
      url,
    ];
  } else {
    args = [
      "-f",
      format,
      "--no-playlist",
      "-N",
      "8",
      "-o",
      `${location}/%(title)s.%(ext)s`,
      url,
    ];
  }

  const ytDlpProcess = spawn(YT_DLP_PATH, args, {
    windowsHide: true,
    stdio: ["ignore", "ignore", "pipe"],
  });

  console.log(`[${id}] yt-dlp iniciado: ${url}`);
  console.log(`[${id}] destino temporario: ${location}`);

  let stderr = "";

  // initialize progress metadata
  if (id && downloads[id]) {
    downloads[id].progress = 0;
    downloads[id].filename = null;
    downloads[id].message = null;
  }

  ytDlpProcess.stderr.on("data", (chunk) => {
    const sRaw = chunk.toString();
    stderr += sRaw;

    try {
      // strip ANSI escape sequences
      const s = sRaw.replace(/\x1b\[[0-9;]*m/g, "");

      // split on CR and LF because yt-dlp updates progress with CR
      const parts = s.split(/\r|\n/).map((p) => p.trim()).filter(Boolean);

      // examine each part for percent or destination
      parts.forEach((part) => {
        // percent like '12.3%'
        const pct = part.match(/(\d{1,3}(?:\.\d+)?)%/);
        if (pct && pct[1] && id && downloads[id]) {
          const num = parseFloat(pct[1]);
          if (!isNaN(num)) {
            const rounded = Math.min(100, Math.max(0, Math.round(num)));
            if (downloads[id].progress !== rounded) {
              downloads[id].progress = rounded;
              downloads[id].message = part;
            }
          }
        }

        // Destination: /path/to/file
        const destMatch = part.match(/Destination:\s*(.+)/i) || part.match(/\[download\]\s*Destination:\s*(.+)/i);
        if (destMatch && destMatch[1] && id && downloads[id]) {
          const full = destMatch[1].trim();
          const partsPath = full.split(/[/\\]/);
          downloads[id].filename = partsPath[partsPath.length - 1];
        }
      });
    } catch (err) {
      // ignore parse errors
    }
  });

  ytDlpProcess.on("error", (error) => {
    console.error(`[${id}] erro ao iniciar yt-dlp: ${error.message}`);

    if (id && downloads[id]) {
      downloads[id].status = "error";
      downloads[id].error = error.message;
    }
  });

  ytDlpProcess.on("exit", (code, signal) => {
  });

  ytDlpProcess.on("close", (code, signal) => {
    console.log(`[${id}] yt-dlp finalizado code=${code} signal=${signal || "none"}`);

    if (code !== 0 && code !== null) {
      const error = new Error(stderr || `yt-dlp finalizou com código ${code}`);
      console.error(`[${id}] erro yt-dlp: ${error.message}`);

      if (id && downloads[id]) {
        downloads[id].status = "error";
        downloads[id].error = error.message;
      }
      return;
    }

    if (id && downloads[id]) {
      const filePath = findDownloadedFile(location);

      console.log(`[${id}] arquivo pronto: ${filePath || "nao encontrado"}`);

      downloads[id].filePath = filePath;
      downloads[id].filename = filePath ? path.basename(filePath) : downloads[id].filename;
      downloads[id].progress = 100;
      downloads[id].status = "done";
    }
  });
};

app.post("/open", (req, res) => {
  if (process.platform !== "win32") {
    return res.status(501).send("Abrir pasta não é suportado neste servidor");
  }

  const { path } = req.body;

  const folderProcess = spawn("cmd", ["/c", "start", "", path], {
    windowsHide: true,
    stdio: "ignore",
  });

  folderProcess.on("error", (error) => {
    return res.status(500).send("Erro ao abrir pasta");
  });

  res.status(200).send("Pasta aberta");
});

app.post("/", (req, res) => {
  const { path: requestedPath, download, url } = req.body;
  const baseDownloadLocation = resolveDownloadLocation(requestedPath);

  console.log(`novo download: tipo=${download || "original"} url=${url || "sem url"}`);

  if (!baseDownloadLocation) {
    return res.status(400).send("Path não enviado");
  }

  if (!url) {
    return res.status(400).send("URL não enviada");
  }

  let format;

  if (download === "whatsapp") {
    format =
      'bv[filesize<20M][ext=mp4]+ba.2 / b[vcodec=libx264] / b';
  } else if (download === "mp3") {
    format = "mp3";
  } else {
    format = "bv*+ba/b";
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const downloadLocation = path.join(baseDownloadLocation, id);

  fs.mkdirSync(downloadLocation, { recursive: true });

  downloads[id] = { status: "in_progress", error: null, workDir: downloadLocation };

  executeYtDlp(id, format, downloadLocation, url);

  res.status(202).json({ id });
});

app.get("/status/:id", (req, res) => {
  const id = req.params.id;

  if (!id || !downloads[id]) {
    return res.status(404).json({ error: "ID não encontrado" });
  }

  return res.status(200).json(downloads[id]);
});

app.get("/file/:id", (req, res) => {
  const id = req.params.id;
  const item = downloads[id];

  if (!item || item.status !== "done" || !item.filePath) {
    return res.status(404).send("Arquivo não encontrado");
  }

  res.download(item.filePath, item.filename || path.basename(item.filePath), (error) => {
    if (error && !res.headersSent) {
      console.error(`[${id}] erro ao enviar arquivo: ${error.message}`);
      res.status(500).send("Erro ao baixar arquivo");
    }

    console.log(`[${id}] limpando arquivo temporario`);
    cleanupDownload(id);
  });
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

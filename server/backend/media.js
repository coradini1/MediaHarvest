const express = require("express");
const { spawn } = require("child_process");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();

app.disable("etag");

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
const CANCEL_RETENTION_MS = 10 * 60 * 1000;
const MAX_CONCURRENT_DOWNLOADS = Math.max(1, Number(process.env.MAX_CONCURRENT_DOWNLOADS) || 2);
const pendingDownloads = [];
let activeDownloads = 0;

const phaseMessages = {
  queued: "Na fila",
  extracting: "Extraindo informações",
  downloading_video: "Baixando vídeo",
  downloading_audio: "Baixando áudio",
  processing: "Processando",
  finalizing: "Finalizando",
  done: "Concluído",
  cancelled: "Cancelado",
  error: "Erro",
};

const resolveDownloadLocation = (requestedPath) => {
  const base = DOWNLOAD_DIR || requestedPath;

  if (!base || typeof base !== "string") {
    return null;
  }

  const resolved = path.resolve(base);

  if (DOWNLOAD_DIR) {
    const allowedRoot = path.resolve(DOWNLOAD_DIR);
    const relative = path.relative(allowedRoot, resolved);

    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      return null;
    }

    return allowedRoot;
  }

  if (!path.isAbsolute(base) || base.split(/[\\/]+/).includes("..")) {
    return null;
  }

  return resolved;
};

const createDownloadState = (overrides = {}) => ({
  status: "queued",
  progress: 0,
  filename: null,
  phase: "queued",
  bytesDownloaded: 0,
  totalBytes: null,
  speed: null,
  eta: null,
  message: phaseMessages.queued,
  error: null,
  process: null,
  cancelled: false,
  ...overrides,
});

const publicDownloadState = (id, item) => ({
  id,
  status: item.status,
  progress: item.progress || 0,
  filename: item.filename || null,
  phase: phaseMessages[item.phase] || item.phase || phaseMessages[item.status] || item.status,
  bytesDownloaded: item.bytesDownloaded || 0,
  totalBytes: item.totalBytes || null,
  speed: item.speed || null,
  eta: item.eta || null,
  processingProgress: item.processingProgress ?? null,
  message: item.status === "queued"
    ? `${item.retryCount ? item.message : "Na fila"} · posição ${Math.max(1, pendingDownloads.indexOf(id) + 1)}`
    : item.message || phaseMessages[item.status] || item.status,
  error: item.error || null,
});

const formatElapsed = (seconds) => {
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
};

const updateDownload = (id, changes) => {
  const item = downloads[id];

  if (!item || item.cancelled || item.status === "cancelled") {
    return false;
  }

  Object.assign(item, changes);
  return true;
};

const listDownloadFiles = (dir) => {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    return entry.isDirectory() ? listDownloadFiles(fullPath) : [fullPath];
  });
};

const startProcessingMonitor = (id) => {
  const item = downloads[id];
  if (!item || item.processingTimer) return;

  const startedAt = Date.now();
  item.processingLastBytes = 0;
  item.processingLastActivityAt = startedAt;
  item.processingTimer = setInterval(() => {
    if (!downloads[id] || item.cancelled || item.status !== "in_progress") return;

    try {
      const files = listDownloadFiles(item.workDir);
      const temporaryFiles = files.filter((file) => path.basename(file).includes(".temp."));
      const sourceFiles = files.filter((file) => {
        const name = path.basename(file);
        return !name.includes(".temp.") && !name.endsWith(".part") && !name.endsWith(".ytdl");
      });
      const sourceBytes = sourceFiles.reduce((total, file) => total + fs.statSync(file).size, 0);
      const processedBytes = temporaryFiles.reduce((total, file) => total + fs.statSync(file).size, 0);
      const processingProgress = sourceBytes > 0
        ? Math.min(100, Math.round((processedBytes / sourceBytes) * 100))
        : 0;
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);

      if (processedBytes !== item.processingLastBytes) {
        item.processingLastBytes = processedBytes;
        item.processingLastActivityAt = Date.now();
      }

      const stalledFor = Date.now() - item.processingLastActivityAt;
      if (stalledFor >= 10 * 60 * 1000) {
        item.status = "error";
        item.phase = "error";
        item.message = "Processamento interrompido por falta de atividade";
        item.error = "O ffmpeg ficou 10 minutos sem gravar dados";
        killProcessTree(item.process);
        return;
      }

      item.phase = "processing";
      item.processingProgress = processingProgress;
      item.progress = Math.min(99, 90 + Math.floor(processingProgress * 0.09));
      item.message = processingProgress > 0
        ? `Processando ${processingProgress}% · ${formatElapsed(elapsedSeconds)}`
        : `Preparando arquivo · ${formatElapsed(elapsedSeconds)}`;
      if (stalledFor >= 5 * 60 * 1000) {
        item.message = `Processamento sem avanço · ${formatElapsed(Math.floor(stalledFor / 1000))}`;
      }
    } catch (_) {}
  }, 2000);
  item.processingTimer.unref?.();
};

const releaseDownloadSlot = (id) => {
  const item = downloads[id];
  if (!item?.slotActive) return;
  item.slotActive = false;
  activeDownloads = Math.max(0, activeDownloads - 1);
  setImmediate(startQueuedDownloads);
};

function startQueuedDownloads() {
  while (activeDownloads < MAX_CONCURRENT_DOWNLOADS && pendingDownloads.length) {
    const id = pendingDownloads.shift();
    const item = downloads[id];
    if (!item || item.cancelled || item.status !== "queued") continue;

    activeDownloads += 1;
    item.slotActive = true;
    executeYtDlp(id, item.format, item.workDir, item.url);
  }
}

app.use((req, res, next) => {
  const startedAt = Date.now();

  if (req.path.startsWith("/status") || req.path.startsWith("/file")) {
    res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
    res.set("Pragma", "no-cache");
    res.set("Expires", "0");
  }

  res.on("finish", () => {
    const durationMs = Date.now() - startedAt;
    console.log(
      `${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode} ${durationMs}ms`
    );
  });

  next();
});

const findDownloadedFile = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const found = findDownloadedFile(fullPath);
      if (found) return found;
    } else if (
      !entry.name.includes(".part") &&
      !entry.name.endsWith(".ytdl") &&
      !entry.name.endsWith(".temp")
    ) {
      return fullPath;
    }
  }

  return null;
};

const sanitizeFilename = (value) => {
  return String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 180);
};

const fallbackTitleFromUrl = (url) => {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const videoIndex = parts.indexOf("video");
    const slug = videoIndex >= 0 ? parts[videoIndex + 1] : null;
    if (!slug) return null;
    const title = decodeURIComponent(slug).replace(/[+_-]+/g, " ").replace(/\s+/g, " ").trim();
    return title ? title.charAt(0).toUpperCase() + title.slice(1) : null;
  } catch (_) {
    return null;
  }
};

const cleanTitleHint = (title, url) => {
  if (!title) return fallbackTitleFromUrl(url);
  const cleaned = sanitizeFilename(title)
    .replace(/\s*[-|]\s*SpankBang.*$/i, "")
    .replace(/^SpankBang\s*[-|]\s*/i, "")
    .trim();
  return cleaned && !/^SpankBang$/i.test(cleaned) ? cleaned : fallbackTitleFromUrl(url);
};

const applyFallbackFilename = (filePath, item) => {
  if (!filePath || !item) return filePath;
  const extension = path.extname(filePath);
  const currentTitle = path.basename(filePath, extension);
  const urlParts = new URL(item.url).pathname.split("/").filter(Boolean);
  const looksLikeId = /^[a-z0-9_-]{3,16}$/i.test(currentTitle) && urlParts.includes(currentTitle);
  if (!looksLikeId) return filePath;

  const fallbackTitle = cleanTitleHint(item.titleHint, item.url);
  if (!fallbackTitle || fallbackTitle.toLowerCase() === currentTitle.toLowerCase()) return filePath;

  const targetPath = path.join(path.dirname(filePath), `${fallbackTitle}${extension}`);
  if (fs.existsSync(targetPath)) return filePath;
  fs.renameSync(filePath, targetPath);
  return targetPath;
};

const cleanupDownload = (id) => {
  const item = downloads[id];

  if (!item || !item.workDir) return;

  fs.rm(item.workDir, { recursive: true, force: true }, () => {
    if (downloads[id] && downloads[id].status !== "cancelled") {
      delete downloads[id];
    }
  });
};

const cleanupCancelledDownload = (id) => {
  const item = downloads[id];

  if (!item) return;

  if (item.workDir) {
    fs.rm(item.workDir, { recursive: true, force: true }, () => {});
  }

  clearTimeout(item.retentionTimer);
  item.retentionTimer = setTimeout(() => {
    if (downloads[id] && downloads[id].status === "cancelled") {
      delete downloads[id];
    }
  }, CANCEL_RETENTION_MS);

  if (item.retentionTimer.unref) {
    item.retentionTimer.unref();
  }
};

const killProcessTree = (child) => {
  if (!child || !child.pid) return;

  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch (error) {
    try {
      child.kill("SIGTERM");
    } catch (_) {}
  }

  setTimeout(() => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      try {
        child.kill("SIGKILL");
      } catch (_) {}
    }
  }, 5000).unref();
};

const formatYtDlpError = (stderr, code) => {
  const fallback = stderr || `yt-dlp finalizou com código ${code}`;

  if (/HTTP Error 410: Gone/i.test(fallback)) {
    return "A pagina do video retornou HTTP 410 Gone. O video pode ter sido removido, bloqueado por regiao/login, ou estar indisponivel para este servidor.";
  }

  if (/no impersonate target is available/i.test(fallback)) {
    return "yt-dlp precisa de suporte a impersonation/curl_cffi para este site. Recrie a imagem Docker para instalar as dependencias atualizadas.";
  }

  if (/Could not resolve host|Temporary failure in name resolution|Failed to resolve/i.test(fallback)) {
    return "Falha temporária de DNS ao localizar o site ou a CDN. Use Repetir para tentar novamente.";
  }

  if (/HTTP Error 502|Bad Gateway/i.test(fallback)) {
    return "O site ou a CDN respondeu com erro temporário 502. Use Repetir para tentar novamente.";
  }

  if (/Cloudflare anti-bot challenge|HTTP Error 403/i.test(fallback)) {
    return "O site bloqueou a requisição com proteção anti-bot. Tente novamente mais tarde.";
  }

  return fallback;
};

const isTransientDownloadError = (error) => {
  return /Could not resolve host|Temporary failure in name resolution|Failed to resolve|HTTP Error 502|Bad Gateway|timed out|Unable to download webpage/i.test(error);
};

const cleanupFailedFiles = (item) => {
  if (!item?.workDir) return;
  fs.rmSync(item.workDir, { recursive: true, force: true });
  fs.mkdirSync(item.workDir, { recursive: true });
};

const parseNumber = (value) => {
  const number = Number(String(value || "").replace(/[^0-9.]/g, ""));
  return Number.isFinite(number) ? number : null;
};

const cleanSpeed = (value) => {
  if (!value || value === "N/A") return null;
  return String(value)
    .replace(/\/s$/i, "")
    .replace(/iB/i, "B")
    .replace(/^(\d+(?:\.\d+)?)([KMGT]?B)$/i, "$1 $2")
    .trim();
};

const parseProgressLine = (line) => {
  const match = line.match(/^MEDIAHARVEST_PROGRESS\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.+?)\s+(\S+)$/);

  if (!match) return null;

  const [, status, percent, downloaded, total, totalEstimate, speed, eta] = match;
  const progress = parseNumber(percent);
  const bytesDownloaded = parseNumber(downloaded);
  const totalBytes = parseNumber(total) || parseNumber(totalEstimate);

  return {
    status,
    progress: progress === null ? null : Math.min(99, Math.max(0, Math.round(progress))),
    bytesDownloaded,
    totalBytes,
    speed: cleanSpeed(speed),
    eta: eta && eta !== "N/A" ? eta : null,
  };
};

const applyProgress = (id, data) => {
  const item = downloads[id];

  if (!item || item.cancelled || item.status === "cancelled") return;

  const next = {
    status: "in_progress",
    phase: data.status === "finished" ? "processing" : item.phase || "downloading_video",
    message: data.status === "finished" ? phaseMessages.processing : phaseMessages.downloading_video,
  };

  if (data.status === "finished") {
    next.speed = null;
    next.eta = null;
  }

  if (data.progress !== null) {
    next.progress = data.status === "finished"
      ? 90
      : Math.min(89, 15 + Math.round(data.progress * 0.74));
  }
  if (data.status !== "finished") next.phase = "downloading_video";
  if (data.bytesDownloaded !== null) next.bytesDownloaded = data.bytesDownloaded;
  if (data.totalBytes !== null) next.totalBytes = data.totalBytes;
  if (data.speed) next.speed = data.speed;
  if (data.eta) next.eta = data.eta;

  updateDownload(id, next);
  if (data.status === "finished") startProcessingMonitor(id);
};

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    activeDownloads,
    queuedDownloads: pendingDownloads.length,
    maxConcurrentDownloads: MAX_CONCURRENT_DOWNLOADS,
  });
});

const executeYtDlp = (id, format, location, url) => {
  const progressArgs = [
    "--newline",
    "--progress",
    "--print",
    "before_dl:MEDIAHARVEST_TOTAL %(filesize,filesize_approx)s",
    "--progress-template",
    "MEDIAHARVEST_PROGRESS %(progress.status)s %(progress._percent_str)s %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress._speed_str)s %(progress._eta_str)s",
    "--print",
    "after_move:MEDIAHARVEST_FILE %(filepath)s",
    "--retries",
    "15",
    "--fragment-retries",
    "15",
    "--extractor-retries",
    "5",
    "--retry-sleep",
    "http:exp=1:20",
    "--retry-sleep",
    "fragment:exp=1:20",
    "--socket-timeout",
    "20",
    "--extractor-args",
    "generic:impersonate",
  ];
  let args;

  if (format === "mp3") {
    args = [
      ...progressArgs,
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
      ...progressArgs,
      "-f",
      format,
      "--no-playlist",
      "-N",
      "4",
      "-o",
      `${location}/%(title)s.%(ext)s`,
      url,
    ];
  }

  const ytDlpProcess = spawn(YT_DLP_PATH, args, {
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (downloads[id]) {
    downloads[id].process = ytDlpProcess;
    downloads[id].status = "in_progress";
    downloads[id].phase = "extracting";
    downloads[id].message = phaseMessages.extracting;
    downloads[id].extractionLabel = "Extraindo";
    const extractionStartedAt = Date.now();
    downloads[id].extractionTimer = setInterval(() => {
      const item = downloads[id];
      if (!item || item.phase !== "extracting" || item.cancelled) return;

      const elapsedSeconds = Math.floor((Date.now() - extractionStartedAt) / 1000);
      item.progress = Math.max(item.progress || 0, Math.min(12, 1 + Math.floor(elapsedSeconds / 4)));
      item.message = `${item.extractionLabel || "Extraindo"} · ${elapsedSeconds}s`;
    }, 2000);
    downloads[id].extractionTimer.unref?.();
  }

  console.log(`[${id}] yt-dlp iniciado: ${url}`);
  console.log(`[${id}] destino temporario: ${location}`);

  let stderr = "";
  let lastLoggedProgress = -1;
  const outputBuffers = { stdout: "", stderr: "" };

  const handleYtDlpOutput = (chunk, stream) => {
    const sRaw = chunk.toString();

    if (stream === "stderr") {
      stderr += sRaw;
    }

    try {
      // strip ANSI escape sequences
      const s = outputBuffers[stream] + sRaw.replace(/\x1b\[[0-9;]*m/g, "");

      // split on CR and LF because yt-dlp updates progress with CR
      const chunks = s.split(/\r|\n/);
      outputBuffers[stream] = chunks.pop() || "";
      const parts = chunks.map((p) => p.trim()).filter(Boolean);

      parts.forEach((part) => {
        const extractionStage = (progress, message) => {
          const item = downloads[id];
          if (!item || item.cancelled || item.phase !== "extracting") return;
          item.progress = Math.max(item.progress || 0, progress);
          item.extractionLabel = message;
          item.message = message;
        };

        if (part.startsWith("MEDIAHARVEST_PROGRESS")) {
          const progress = parseProgressLine(part);

          if (progress) {
            applyProgress(id, progress);

            if (progress.progress !== null && progress.progress >= lastLoggedProgress + 10) {
              lastLoggedProgress = progress.progress;
              console.log(`[${id}] progresso ${progress.progress}%`);
            }
          }

          return;
        }

        if (/Could not resolve host|Temporary failure in name resolution|HTTP Error 502|Bad Gateway|timed out/i.test(part)) {
          updateDownload(id, {
            message: "Falha de rede · tentando novamente",
          });
        }

        if (part.startsWith("MEDIAHARVEST_TOTAL")) {
          const totalBytes = parseNumber(part.replace(/^MEDIAHARVEST_TOTAL\s+/, ""));

          if (totalBytes > 0) {
            updateDownload(id, {
              totalBytes,
              phase: "downloading_video",
              message: phaseMessages.downloading_video,
            });
          }

          return;
        }

        if (/Extracting URL/i.test(part)) extractionStage(2, "Abrindo página");
        else if (/Downloading .*webpage/i.test(part)) extractionStage(4, "Lendo página");
        else if (/Downloading m3u8 information/i.test(part)) {
          extractionStage(Math.min(10, (downloads[id]?.progress || 5) + 1), "Buscando qualidades");
        } else if (/Downloading JSON metadata/i.test(part)) extractionStage(11, "Lendo metadados");
        else if (/\[info\].*Downloading/i.test(part)) extractionStage(14, "Preparando mídia");

        if (part.startsWith("MEDIAHARVEST_FILE")) {
          const full = part.replace(/^MEDIAHARVEST_FILE\s+/, "").trim();

          if (full && id && downloads[id] && !downloads[id].cancelled) {
            downloads[id].filePath = full;
            downloads[id].filename = path.basename(full);
            downloads[id].phase = "finalizing";
            downloads[id].message = phaseMessages.finalizing;
          }

          return;
        }

        if (/\[hlsnative\].*Downloading/i.test(part)) {
          updateDownload(id, {
            phase: "downloading_video",
            message: phaseMessages.downloading_video,
          });
        }

        const destMatch = part.match(/Destination:\s*(.+)/i) || part.match(/\[download\]\s*Destination:\s*(.+)/i);
        if (destMatch && destMatch[1] && id && downloads[id] && !downloads[id].cancelled) {
          const full = destMatch[1].trim();
          const partsPath = full.split(/[/\\]/);
          downloads[id].filename = partsPath[partsPath.length - 1];
          console.log(`[${id}] arquivo destino: ${downloads[id].filename}`);
          return;
        }

        if (/ExtractAudio|Deleting original file/i.test(part) && id && downloads[id] && !downloads[id].cancelled) {
          downloads[id].phase = "downloading_audio";
          downloads[id].message = phaseMessages.downloading_audio;
          return;
        }

        if (/Fixup|Merging|ffmpeg|post-process/i.test(part) && id && downloads[id] && !downloads[id].cancelled) {
          downloads[id].progress = Math.max(90, downloads[id].progress || 0);
          downloads[id].phase = "finalizing";
          downloads[id].message = phaseMessages.finalizing;
          startProcessingMonitor(id);
          console.log(`[${id}] finalizando arquivo`);
          return;
        }

        if (!part.includes("[download]")) {
          console.log(`[${id}] yt-dlp ${stream}: ${part}`);
        }
      });
    } catch (err) {
      // ignore parse errors
    }
  };

  ytDlpProcess.stdout.on("data", (chunk) => handleYtDlpOutput(chunk, "stdout"));
  ytDlpProcess.stderr.on("data", (chunk) => handleYtDlpOutput(chunk, "stderr"));

  ytDlpProcess.on("error", (error) => {
    clearInterval(downloads[id]?.extractionTimer);
    clearInterval(downloads[id]?.processingTimer);
    console.error(`[${id}] erro ao iniciar yt-dlp: ${error.message}`);

    updateDownload(id, {
      status: "error",
      phase: "error",
      message: "Falha ao iniciar o download",
      error: error.message,
    });
  });

  ytDlpProcess.on("exit", (code, signal) => {
  });

  ytDlpProcess.on("close", (code, signal) => {
    handleYtDlpOutput("\n", "stdout");
    handleYtDlpOutput("\n", "stderr");
    clearInterval(downloads[id]?.extractionTimer);
    clearInterval(downloads[id]?.processingTimer);
    console.log(`[${id}] yt-dlp finalizado code=${code} signal=${signal || "none"}`);

    if (!downloads[id] || downloads[id].cancelled || ["cancelled", "error"].includes(downloads[id].status)) {
      if (downloads[id]?.status === "error") cleanupFailedFiles(downloads[id]);
      releaseDownloadSlot(id);
      return;
    }

    if (code !== 0 && code !== null) {
      const rawError = stderr || `yt-dlp finalizou com código ${code}`;
      const error = new Error(formatYtDlpError(rawError, code));
      console.error(`[${id}] erro yt-dlp: ${error.message}`);

      if (isTransientDownloadError(rawError) && (downloads[id].retryCount || 0) < 2) {
        const retryCount = (downloads[id].retryCount || 0) + 1;
        cleanupFailedFiles(downloads[id]);
        updateDownload(id, {
          status: "queued",
          phase: "queued",
          progress: 0,
          filename: null,
          bytesDownloaded: 0,
          totalBytes: null,
          speed: null,
          eta: null,
          retryCount,
          message: `Nova tentativa automática ${retryCount}/2`,
          error: null,
          process: null,
        });
        pendingDownloads.push(id);
        releaseDownloadSlot(id);
        return;
      }

      updateDownload(id, {
        status: "error",
        phase: "error",
        message: "Erro no download",
        error: error.message,
      });
      cleanupFailedFiles(downloads[id]);
      releaseDownloadSlot(id);
      return;
    }

    if (id && downloads[id]) {
      const foundFilePath = findDownloadedFile(location);
      const filePath = foundFilePath ? applyFallbackFilename(foundFilePath, downloads[id]) : null;

      console.log(`[${id}] arquivo pronto: ${filePath || "nao encontrado"}`);

      if (!filePath) {
        updateDownload(id, {
          status: "error",
          phase: "error",
          message: "Arquivo final não encontrado",
          error: "yt-dlp finalizou, mas nenhum arquivo final foi encontrado",
        });
        releaseDownloadSlot(id);
        return;
      }

      updateDownload(id, {
        filePath,
        filename: path.basename(filePath),
        bytesDownloaded: fs.statSync(filePath).size,
        totalBytes: fs.statSync(filePath).size,
        progress: 100,
        status: "done",
        phase: "done",
        message: phaseMessages.done,
        speed: null,
        eta: null,
      });
      releaseDownloadSlot(id);
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
  const { path: requestedPath, download, url, title } = req.body;
  const baseDownloadLocation = resolveDownloadLocation(requestedPath);

  console.log(`novo download: tipo=${download || "original"} url=${url || "sem url"}`);

  if (!baseDownloadLocation) {
    return res.status(400).send("Path inválido ou não permitido");
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

  const existingDownload = Object.entries(downloads).find(([, item]) => {
    return ["queued", "in_progress"].includes(item.status) && item.url === url && item.download === download;
  });

  if (existingDownload) {
    const [existingId] = existingDownload;
    console.log(`[${existingId}] download duplicado ignorado: ${url}`);
    return res.status(202).json({ id: existingId, existing: true });
  }

  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const downloadLocation = path.join(baseDownloadLocation, id);

  fs.mkdirSync(downloadLocation, { recursive: true });

  downloads[id] = createDownloadState({
    workDir: downloadLocation,
    url,
    download,
    titleHint: title,
    format,
    createdAt: new Date().toISOString(),
  });

  pendingDownloads.push(id);
  startQueuedDownloads();

  res.status(202).json({ id });
});

app.get("/status/:id", (req, res) => {
  const id = req.params.id;

  if (!id || !downloads[id]) {
    return res.status(404).json({ error: "ID não encontrado" });
  }

  const downloadUrl = `/file/${encodeURIComponent(id)}`;

  return res.status(200).json({
    ...publicDownloadState(id, downloads[id]),
    downloadUrl,
    downloadUrlAbsolute: `${req.protocol}://${req.get("host")}${downloadUrl}`,
  });
});

app.delete("/downloads/:id", (req, res) => {
  const id = req.params.id;
  const item = downloads[id];

  if (!id || !item) {
    return res.status(404).json({ error: "ID não encontrado" });
  }

  if (["done", "error", "cancelled"].includes(item.status)) {
    return res.status(409).json({ id, status: item.status });
  }

  item.cancelled = true;
  item.status = "cancelled";
  item.phase = "cancelled";
  item.progress = item.progress || 0;
  item.message = phaseMessages.cancelled;
  item.error = null;

  killProcessTree(item.process);
  cleanupCancelledDownload(id);

  return res.status(200).json({ id, status: "cancelled" });
});

app.get("/file/:id", (req, res) => {
  const id = req.params.id;
  const item = downloads[id];

  if (!item || item.status !== "done" || !item.filePath) {
    console.warn(`[${id}] arquivo solicitado mas nao esta pronto`);
    return res.status(404).send("Arquivo não encontrado");
  }

  if (!fs.existsSync(item.filePath)) {
    console.error(`[${id}] arquivo solicitado mas nao existe mais: ${item.filePath}`);
    item.status = "error";
    item.error = "Arquivo não existe mais no servidor";
    return res.status(404).send("Arquivo não encontrado");
  }

  console.log(`[${id}] enviando arquivo para navegador: ${item.filename || path.basename(item.filePath)}`);

  res.download(item.filePath, item.filename || path.basename(item.filePath), (error) => {
    if (error) {
      console.error(`[${id}] erro ao enviar arquivo: ${error.message}`);

      if (!res.headersSent) {
        return res.status(500).send("Erro ao baixar arquivo");
      }

      return;
    }

    console.log(`[${id}] arquivo enviado, limpando arquivo temporario`);
    cleanupDownload(id);
  });
});

const PORT = process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

module.exports = {
  app,
  downloads,
  parseProgressLine,
  resolveDownloadLocation,
  fallbackTitleFromUrl,
  cleanTitleHint,
};

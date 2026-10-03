const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const childProcess = require("node:child_process");

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mediaharvest-test-"));
process.env.DOWNLOAD_DIR = tmpRoot;
process.env.MAX_CONCURRENT_DOWNLOADS = "100";

const realSpawn = childProcess.spawn;
const spawned = [];
let nextPid = 50000;

childProcess.spawn = (command, args, options) => {
  const proc = new EventEmitter();
  proc.command = command;
  proc.args = args;
  proc.options = options;
  proc.pid = nextPid++;
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.kill = (signal) => {
    proc.killedSignal = signal;
    process.nextTick(() => proc.emit("close", null, signal));
    return true;
  };
  spawned.push(proc);
  return proc;
};

const { app, downloads } = require("../backend/media");

let server;
let baseUrl;

const request = async (method, route, body) => {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let data = text;

  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {}

  return { response, data, text };
};

const createDownload = async (extra = {}) => {
  const before = spawned.length;
  const result = await request("POST", "/", {
    url: `https://example.com/video-${Date.now()}-${Math.random()}`,
    path: tmpRoot,
    download: "original",
    ...extra,
  });

  assert.equal(result.response.status, 202);
  assert.ok(result.data.id);
  await waitFor(() => spawned.length > before || downloads[result.data.id].status === "error");
  return result.data.id;
};

const failWithGenericExtractor = async (proc) => {
  const before = spawned.length;

  proc.stderr.write("ERROR: [generic] test: Unable to download webpage: HTTP Error 403: Forbidden\n");
  proc.emit("close", 1, null);
  await waitFor(() => spawned.length > before);

  return spawned.at(-1);
};

const waitFor = async (predicate) => {
  for (let i = 0; i < 20; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(predicate(), true);
};

test.before(async () => {
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  childProcess.spawn = realSpawn;
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test("cria download", async () => {
  const before = spawned.length;
  const id = await createDownload();

  assert.equal(downloads[id].status, "in_progress");
  assert.equal(spawned.length, before + 1);
  assert.ok(spawned.at(-1).args.includes("--progress-template"));
  assert.ok(spawned.at(-1).args.includes("--force-ipv4"));
  assert.equal(spawned.at(-1).options.stdio[1], "pipe");
});

test("resolve pagina de arquivo hospedado antes do yt-dlp", async () => {
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    const value = String(url);

    if (value === "https://files.example.test/f/abc123") {
      return new Response(`
        <meta property="og:title" content="video.mp4">
        <script>
          var jsCDN = "https:\/\/cdn.example.test\/storage\/media\/video.mp4";
          var signUrl = "https://sign.example.test/sign";
        </script>
      `, { status: 200 });
    }

    if (value.startsWith("https://sign.example.test/sign")) {
      assert.match(value, /path=%2Fstorage%2Fmedia%2Fvideo\.mp4/);
      return Response.json({ token: "abc", ex: 123 });
    }

    return originalFetch(url, options);
  };

  try {
    const id = await createDownload({ url: "https://files.example.test/f/abc123" });
    const proc = spawned.at(-1);

    assert.equal(downloads[id].filename, "video.mp4");
    assert.equal(proc.args.at(-1), "https://cdn.example.test/storage/media/video.mp4?token=abc&ex=123");
    assert.ok(proc.args.includes("--referer"));
    assert.ok(proc.args.includes("https://files.example.test/f/abc123"));
    assert.ok(proc.args.includes(path.join(downloads[id].workDir, "video.mp4")));
    assert.equal(proc.args[proc.args.indexOf("-N") + 1], "1");
    assert.ok(proc.args.includes("--no-warnings"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("extrai mp4 direto de pagina x-fetish quando o yt-dlp nao reconhece o site", async () => {
  const originalFetch = global.fetch;
  const pageUrl = "https://x-fetish.tube/video/362759/test-video/";
  const directUrl = "https://x-fetish.tube/get_file/11/803ee30884532be4521e8a17bf18358e47f18f2123/362000/362759/362759_720p.mp4/?br=1205";

  global.fetch = async (url, options) => {
    if (String(url) === directUrl && options.method === "HEAD") {
      assert.equal(options.headers.referer, pageUrl);
      return new Response(null, {
        status: 200,
        headers: {
          "content-type": "video/mp4",
          "content-length": "158008576",
        },
      });
    }

    if (String(url) !== pageUrl) {
      return originalFetch(url, options);
    }

    assert.match(options.headers["user-agent"], /Chrome/);

    return new Response(`
      <title>Example Video - Fetish-themed Porn video</title>
      <script>
        var player = {
          license_code: '$545308317990675',
          event_reporting2: 'https://x-fetish.tube/get_file/1/b38e18ef18d3d74e5804dc18b53beb80a4adf368cc/362000/362759/362759.mp4/',
          video_url: 'function/0/https://x-fetish.tube/get_file/11/e43571af58e82308188ee401283be35b47f18f2123/362000/362759/362759_720p.mp4/?br=1205'
        };
      </script>
    `, { status: 200 });
  };

  try {
    const id = await createDownload({ url: pageUrl });

    assert.equal(spawned.at(-1).args.at(-1), pageUrl);

    const proc = await failWithGenericExtractor(spawned.at(-1));

    assert.equal(downloads[id].filename, "Example Video - Fetish-themed Porn video.mp4");
    assert.equal(proc.args.at(-1), directUrl);
    assert.ok(proc.args.includes("--referer"));
    assert.ok(proc.args.includes(pageUrl));
    assert.equal(proc.args[proc.args.indexOf("-N") + 1], "1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("resolve pagina HTML generica para URL direta com fallback de DNS", async () => {
  const originalFetch = global.fetch;
  const pageUrl = "https://video.example.test/watch/abc123";
  const fallbackUrl = "https://127.0.0.1/videos/test-low.mp4";

  global.fetch = async (url, options) => {
    if (String(url) !== pageUrl) {
      return originalFetch(url, options);
    }

    assert.match(options.headers["user-agent"], /Chrome/);

    return new Response(`
      <meta property="og:title" content="Example hosted video - Example Site">
      <script>
        html5player.setVideoUrlHigh('https://media.invalid/videos/test-high.mp4');
        html5player.setVideoUrlLow('${fallbackUrl}');
      </script>
    `, { status: 200 });
  };

  try {
    const id = await createDownload({ url: pageUrl });

    assert.equal(spawned.at(-1).args.at(-1), pageUrl);

    const proc = await failWithGenericExtractor(spawned.at(-1));

    assert.equal(downloads[id].filename, "Example hosted video.mp4");
    assert.equal(proc.args.at(-1), fallbackUrl);
    assert.ok(proc.args.includes("--referer"));
    assert.ok(proc.args.includes(pageUrl));
    assert.equal(proc.args[proc.args.indexOf("-N") + 1], "1");
  } finally {
    global.fetch = originalFetch;
  }
});

test("prioriza maior qualidade em pagina HTML generica", async () => {
  const originalFetch = global.fetch;
  const pageUrl = "https://video.example.test/watch/best-quality";
  const bestUrl = "https://127.0.0.1/videos/master.m3u8";

  global.fetch = async (url, options) => {
    if (String(url) !== pageUrl) {
      return originalFetch(url, options);
    }

    return new Response(`
      <meta property="og:title" content="Best Quality Video - Example Site">
      <video src="https://127.0.0.1/videos/video-480p.mp4"></video>
      <script>
        player.setVideoUrlLow('https://127.0.0.1/videos/video-360p.mp4');
        player.setVideoUrlHigh('https://127.0.0.1/videos/video-1080p.mp4');
        player.setVideoHLS('${bestUrl}');
      </script>
    `, { status: 200 });
  };

  try {
    const id = await createDownload({ url: pageUrl });

    assert.equal(spawned.at(-1).args.at(-1), pageUrl);

    const proc = await failWithGenericExtractor(spawned.at(-1));

    assert.equal(proc.args.at(-1), bestUrl);
    assert.ok(proc.args.includes("--referer"));
    assert.ok(proc.args.includes(pageUrl));
    assert.equal(downloads[id].filename, "Best Quality Video.mp4");
    assert.ok(proc.args.includes(path.join(downloads[id].workDir, "Best Quality Video.mp4")));
  } finally {
    global.fetch = originalFetch;
  }
});

test("nao raspa a pagina antes de deixar o yt-dlp tentar", async () => {
  const originalFetch = global.fetch;
  const pageUrl = "https://pt.pornhub.com/view_video.php?viewkey=abc123";
  let scraped = false;

  global.fetch = async (url, options) => {
    if (String(url) === pageUrl) {
      scraped = true;
      return new Response('<video src="https://cdn.invalid/1080P_8000K_1.mp4"></video>', { status: 200 });
    }

    return originalFetch(url, options);
  };

  try {
    await createDownload({ url: pageUrl });
    const proc = spawned.at(-1);

    assert.equal(scraped, false, "a pagina nao deve ser raspada antes do yt-dlp");
    assert.equal(proc.args.at(-1), pageUrl);
    assert.ok(!proc.args.includes("--referer"));
  } finally {
    global.fetch = originalFetch;
  }
});

test("nao refaz em conexao unica quando a falha foi de extracao", async () => {
  const id = await createDownload();
  const proc = spawned.at(-1);
  const before = spawned.length;

  proc.stderr.write("ERROR: [PornHub] abc: Unable to download webpage: HTTP Error 403: Forbidden\n");
  proc.emit("close", 1, null);
  await waitFor(() => downloads[id].status === "error");

  assert.equal(spawned.length, before);
  assert.match(downloads[id].error, /anti-bot/i);
  assert.match(downloads[id].errorDetail, /403/);
});

test("atualiza progresso estruturado", async () => {
  const id = await createDownload();
  const proc = spawned.at(-1);

  proc.stdout.write("MEDIAHARVEST_PROGRESS downloading 42.0% 12345678 45678900 N/A 4.2MiB/s 00:18\n");
  await waitFor(() => downloads[id].progress === 46);

  const result = await request("GET", `/status/${encodeURIComponent(id)}`);

  assert.equal(result.response.status, 200);
  assert.equal(result.data.progress, 46);
  assert.equal(result.data.bytesDownloaded, 12345678);
  assert.equal(result.data.totalBytes, 45678900);
  assert.equal(result.data.speed, "4.2 MB");
  assert.equal(result.data.eta, "00:18");
  assert.equal(result.data.message, "Baixando vídeo");
});

test("marca conclusão e preserva GET /file", async () => {
  const id = await createDownload();
  const proc = spawned.at(-1);
  const filePath = path.join(downloads[id].workDir, "video.mp4");
  fs.writeFileSync(filePath, "ok");

  proc.emit("close", 0, null);
  await waitFor(() => downloads[id].status === "done");

  const status = await request("GET", `/status/${encodeURIComponent(id)}`);
  assert.equal(status.data.status, "done");
  assert.equal(status.data.progress, 100);
  assert.equal(status.data.filename, "video.mp4");

  const file = await request("GET", `/file/${encodeURIComponent(id)}`);
  assert.equal(file.response.status, 200);
  assert.match(file.response.headers.get("content-disposition"), /video\.mp4/);
});

const nextSpawnOf = async (command) => {
  const before = spawned.length;
  await waitFor(() => spawned.slice(before).some((proc) => proc.command === command)
    || spawned.some((proc) => proc.command === command && !proc.answered));
  return spawned.find((proc) => proc.command === command && !proc.answered);
};

const answerFfprobe = async (streams, format = {}) => {
  const proc = await nextSpawnOf("ffprobe");
  proc.answered = true;
  proc.stdout.write(JSON.stringify({ streams, format: { duration: "25.0", format_name: "mov,mp4,m4a,3gp,3g2,mj2", ...format } }));
  proc.emit("close", 0, null);
  return proc;
};

const answerFfmpeg = async (bytes = "convertido") => {
  const proc = await nextSpawnOf("ffmpeg");
  proc.answered = true;
  fs.writeFileSync(proc.args.at(-1), bytes);
  proc.emit("close", 0, null);
  return proc;
};

const H264_STREAM = { codec_type: "video", codec_name: "h264", width: 720, height: 1280, pix_fmt: "yuv420p" };
const VP9_STREAM = { codec_type: "video", codec_name: "vp9", width: 1080, height: 1920, pix_fmt: "yuv420p" };
const AAC_LC_STREAM = { codec_type: "audio", codec_name: "aac", profile: "LC" };
const AAC_HE_STREAM = { codec_type: "audio", codec_name: "aac", profile: "HE-AAC" };

test("modo whatsapp pede H.264 e forca container mp4", async () => {
  const id = await createDownload({ download: "whatsapp" });
  const args = spawned.at(-1).args;
  const format = args[args.indexOf("-f") + 1];

  assert.match(format, /vcodec\^=avc1/);
  assert.equal(args[args.indexOf("--merge-output-format") + 1], "mp4");
  assert.match(args[args.indexOf("-S") + 1], /vcodec:h264/);

  await request("DELETE", `/downloads/${encodeURIComponent(id)}`);
  await waitFor(() => downloads[id].status === "cancelled");
});

test("converte video VP9 do instagram para H.264 antes de concluir", async () => {
  const id = await createDownload({ download: "whatsapp" });
  const proc = spawned.at(-1);
  const filePath = path.join(downloads[id].workDir, "reel.mp4");
  fs.writeFileSync(filePath, "vp9");

  proc.emit("close", 0, null);
  await answerFfprobe([VP9_STREAM, AAC_HE_STREAM]);

  const ffmpeg = await answerFfmpeg();
  assert.equal(ffmpeg.args[ffmpeg.args.indexOf("-c:v") + 1], "libx264");
  assert.equal(ffmpeg.args[ffmpeg.args.indexOf("-pix_fmt") + 1], "yuv420p");
  assert.ok(ffmpeg.args.includes("+faststart"));

  await waitFor(() => downloads[id].status === "done");
  assert.equal(downloads[id].filename, "reel.mp4");
  assert.equal(fs.readFileSync(downloads[id].filePath, "utf8"), "convertido");
});

test("nao reencoda video que ja e H.264 com AAC-LC", async () => {
  const ffmpegCallsBefore = spawned.filter((item) => item.command === "ffmpeg").length;
  const id = await createDownload({ download: "whatsapp" });
  const proc = spawned.at(-1);
  const filePath = path.join(downloads[id].workDir, "ok.mp4");
  fs.writeFileSync(filePath, "ja serve");

  proc.emit("close", 0, null);
  await answerFfprobe([H264_STREAM, AAC_LC_STREAM]);
  await waitFor(() => downloads[id].status === "done");

  assert.equal(spawned.filter((item) => item.command === "ffmpeg").length, ffmpegCallsBefore);
  assert.equal(fs.readFileSync(downloads[id].filePath, "utf8"), "ja serve");
});

test("troca so o audio quando o video ja e H.264 mas o audio e HE-AAC", async () => {
  const id = await createDownload({ download: "whatsapp" });
  const proc = spawned.at(-1);
  fs.writeFileSync(path.join(downloads[id].workDir, "he.mp4"), "he-aac");

  proc.emit("close", 0, null);
  await answerFfprobe([H264_STREAM, AAC_HE_STREAM]);

  const ffmpeg = await answerFfmpeg();
  assert.equal(ffmpeg.args[ffmpeg.args.indexOf("-c:v") + 1], "copy");
  assert.equal(ffmpeg.args[ffmpeg.args.indexOf("-c:a") + 1], "aac");
  assert.equal(ffmpeg.args[ffmpeg.args.indexOf("-profile:a") + 1], "aac_low");

  await waitFor(() => downloads[id].status === "done");
});

test("download original nao passa pela conversao de whatsapp", async () => {
  const before = spawned.length;
  const id = await createDownload();
  const proc = spawned.at(-1);
  fs.writeFileSync(path.join(downloads[id].workDir, "orig.webm"), "original");

  proc.emit("close", 0, null);
  await waitFor(() => downloads[id].status === "done");

  assert.ok(!spawned.slice(before).some((item) => item.command === "ffprobe"));
});

test("marca erro", async () => {
  const id = await createDownload();
  const proc = spawned.at(-1);

  proc.stderr.write("HTTP Error 410: Gone\n");
  proc.emit("close", 1, null);
  await waitFor(() => downloads[id].status === "error");

  const status = await request("GET", `/status/${encodeURIComponent(id)}`);
  assert.equal(status.data.status, "error");
  assert.match(status.data.error, /HTTP 410 Gone/);
});

test("cancela e limpa arquivos temporários", async () => {
  const id = await createDownload();
  const workDir = downloads[id].workDir;
  fs.writeFileSync(path.join(workDir, "video.part"), "part");
  fs.writeFileSync(path.join(workDir, "video.ytdl"), "meta");

  const result = await request("DELETE", `/downloads/${encodeURIComponent(id)}`);

  assert.equal(result.response.status, 200);
  assert.deepEqual(result.data, { id, status: "cancelled" });
  assert.equal(downloads[id].status, "cancelled");
  await waitFor(() => !fs.existsSync(workDir));

  spawned.at(-1).emit("close", 0, null);
  assert.equal(downloads[id].status, "cancelled");
});

test("cancelamento repetido retorna 409", async () => {
  const id = await createDownload();

  assert.equal((await request("DELETE", `/downloads/${encodeURIComponent(id)}`)).response.status, 200);
  assert.equal((await request("DELETE", `/downloads/${encodeURIComponent(id)}`)).response.status, 409);
});

test("ID inexistente retorna 404", async () => {
  assert.equal((await request("GET", "/status/inexistente")).response.status, 404);
  assert.equal((await request("DELETE", "/downloads/inexistente")).response.status, 404);
});

test("cancelar download concluído retorna 409", async () => {
  const id = await createDownload();
  const filePath = path.join(downloads[id].workDir, "done.mp4");
  fs.writeFileSync(filePath, "ok");
  spawned.at(-1).emit("close", 0, null);
  await waitFor(() => downloads[id].status === "done");

  const result = await request("DELETE", `/downloads/${encodeURIComponent(id)}`);
  assert.equal(result.response.status, 409);
});

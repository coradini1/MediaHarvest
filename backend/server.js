const express = require("express");
const { exec } = require("child_process");
const cors = require("cors");
const bodyParser = require("body-parser");

const app = express();

const allowChromeExtension = (req, res, next) => {
  const origin = req.get("origin");
  if (origin && origin.startsWith("chrome-extension://")) {
    next();
  } else {
    res.status(403).send("Acesso negado pelo CORS");
  }
};

app.use(cors());
app.use(bodyParser.json());
app.use(allowChromeExtension);

const executeYtDlp = (format, location, url, callback) => {
  let command;
  if (format === "mp3") {
    command = `yt-dlp --extract-audio --audio-format mp3 --embed-thumbnail --add-metadata -x -o "${location}/%(title)s.%(ext)s" "${url}"`;
  } else {
    command = `yt-dlp -f "${format}" -P "${location}" "${url}"`;
  }

  exec(command, (error, stdout, stderr) => {
    if (error) {
      console.error(`Erro ao executar o comando: ${error.message}`);
      callback(error);
      return;
    }
    if (stderr) {
      console.error(`Erro de execução: ${stderr}`);
      callback(new Error(stderr));
      return;
    }
    callback(null, stdout);
  });
};

app.post("/open", (req, res) => {
  const { path } = req.body;
  exec(`start "" "${path}"`, (error, stdout, stderr) => {
    if (error) {
      console.error(`Erro ao abrir a pasta: ${error.message}`);
      res.status(500).send("Erro ao abrir a pasta");
      return;
    }
    if (stderr) {
      console.error(`Erro de execução: ${stderr}`);
      res.status(500).send("Erro ao abrir a pasta");
      return;
    }
    res.status(200).send("Pasta aberta!");
  });
});

app.post("/", (req, res) => {
  const { path, download, url } = req.body;

  let format;
  if (download === "whatsapp") {
    format = "bv[filesize<20M][ext=mp4]+ba.2 / b[vcodec=libx264] / b";
  } else if (download === "mp3") {
    format = "mp3";
  } else {
    format = "bv*+ba/b";
  }

  executeYtDlp(format, path, url, (error, stdout) => {
    if (error) {
      res.status(500).send("Erro ao processar o download");
      return;
    }
    res.status(200).send("done");
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

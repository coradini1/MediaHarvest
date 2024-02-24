const express = require("express");
const { exec } = require("child_process");
const cors = require("cors");
const { stdout } = require("process");
const bodyParser = require("body-parser");

const app = express();

const dynamicCorsOrigin = function (origin, callback) {
  if (origin && origin.startsWith("chrome-extension://")) {
    callback(null, true);
  } else {
    callback(new Error("Não permitido pelo CORS"));
  }
};

app.use(
  cors({
    origin: dynamicCorsOrigin,
  })
);

app.use(bodyParser.json());

app.post("/", (req, res) => {
  const body = req.body;
  const location = body.path;
  exec(
    `yt-dlp -f "bv*+ba/b" --audio-multistreams -P "${location}" "${body.url}"`,
    (stdout) => {
     res.status(200).send("done");
    }
  );
});

app.listen(3000, () => {
  console.log("Server is running on http://localhost:3000");
});

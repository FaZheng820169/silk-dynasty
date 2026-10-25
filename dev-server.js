/**
 * Local dev server: serves the static site AND mounts the /api/generate
 * function so the full Studio flow can be tested before deploying to Vercel.
 *
 *   node dev-server.js        # http://127.0.0.1:8080
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const generate = require("./api/generate.js");

const ROOT = __dirname;
const PORT = process.env.PORT || 8080;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); }
      catch { resolve({}); }
    });
  });
}

const server = http.createServer(async (req, res) => {
  // API route
  if (req.url.startsWith("/api/generate")) {
    const body = req.method === "POST" ? await readBody(req) : {};
    const mockReq = { method: req.method, body };
    const mockRes = {
      headers: {},
      setHeader(k, v) { this.headers[k] = v; },
      status(code) { this.statusCode = code; return this; },
      json(payload) {
        res.writeHead(this.statusCode || 200, Object.assign({ "Content-Type": "application/json" }, this.headers));
        res.end(JSON.stringify(payload));
      },
    };
    await generate(mockReq, mockRes);
    return;
  }

  // Static
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(ROOT, urlPath);
  if (!filePath.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Silk Dynasty dev server → http://127.0.0.1:${PORT}`);
});

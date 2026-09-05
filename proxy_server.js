// Simple reverse proxy: serves frontend static files + proxies /api/v1 and /ws to backend
// Zero external dependencies — uses only Node built-ins
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

const PORT = 8325;
const FRONTEND_DIR = path.join(__dirname, "frontend");
const BACKEND_HOST = "localhost";
const BACKEND_PORT = 8001;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

function serveStatic(req, res, pathname) {
  // Default entry point
  if (pathname === "/" || pathname === "") pathname = "/pages/index.html";

  // Prevent path traversal — normalize to forward slashes for consistent comparison
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.resolve(FRONTEND_DIR, "." + safePath);
  const frontendResolved = path.resolve(FRONTEND_DIR);

  if (!filePath.startsWith(frontendResolved)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      // If file not found, try index.html (SPA fallback)
      if (err.code === "ENOENT" && !pathname.endsWith(".js") && !pathname.endsWith(".css")) {
        fs.readFile(path.join(FRONTEND_DIR, "index.html"), (e2, d2) => {
          if (e2) {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("404 Not Found: " + pathname);
          } else {
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(d2);
          }
        });
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("404 Not Found: " + pathname);
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const headers = { "Content-Type": MIME[ext] || "application/octet-stream" };
    // 对 .js/.css/.html 添加 no-cache，避免浏览器缓存旧版本代码
    if (ext === ".js" || ext === ".css" || ext === ".html") {
      headers["Cache-Control"] = "no-cache, no-store, must-revalidate";
      headers["Pragma"] = "no-cache";
      headers["Expires"] = "0";
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

function proxyHttp(req, res) {
  const parsed = url.parse(req.url);
  const options = {
    hostname: BACKEND_HOST,
    port: BACKEND_PORT,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${BACKEND_HOST}:${BACKEND_PORT}` },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res, { end: true });
  });

  proxyReq.on("error", (e) => {
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Bad Gateway", detail: e.message }));
  });

  req.pipe(proxyReq, { end: true });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url);
  const pathname = parsed.pathname || "/";

  // Proxy API and WS upgrade requests to backend
  if (pathname.startsWith("/api/") || pathname.startsWith("/ws/")) {
    proxyHttp(req, res);
  } else {
    serveStatic(req, res, pathname);
  }
});

// WebSocket proxy
server.on("upgrade", (req, socket, head) => {
  const options = {
    hostname: BACKEND_HOST,
    port: BACKEND_PORT,
    path: req.url,
    method: "GET",
    headers: { ...req.headers, host: `${BACKEND_HOST}:${BACKEND_PORT}` },
  };

  const proxyReq = http.request(options);
  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${proxyRes.headers["sec-websocket-accept"]}\r\n` +
      (proxyRes.headers["sec-websocket-extensions"]
        ? `Sec-WebSocket-Extensions: ${proxyRes.headers["sec-websocket-extensions"]}\r\n`
        : "") +
      "\r\n"
    );
    if (proxyHead && proxyHead.length) socket.write(proxyHead);
    proxySocket.pipe(socket);
    socket.pipe(proxySocket);

    proxySocket.on("error", () => socket.destroy());
    socket.on("error", () => proxySocket.destroy());
  });

  proxyReq.on("error", (e) => {
    socket.destroy();
  });

  proxyReq.end();
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[proxy] Frontend: http://localhost:${PORT}`);
  console.log(`[proxy] Static dir: ${FRONTEND_DIR}`);
  console.log(`[proxy] Backend proxy: http://${BACKEND_HOST}:${BACKEND_PORT}`);
});

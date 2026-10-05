/*!
 * 算账稿纸 · 本地静态服务器（零依赖）
 * 用途：本地预览与 PWA 验证（Service Worker 需要 http 环境）
 * 用法：node tools/serve.mjs [port] [host]
 *   默认监听 0.0.0.0:8185，局域网内其他设备（手机）可直接访问
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { networkInterfaces } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || process.env.PORT || 8185);
const HOST = process.argv[3] || process.env.HOST || "0.0.0.0";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon"
};

const server = createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (path.endsWith("/")) path += "index.html";
    const target = join(ROOT, normalize(path).replace(/^(\.\.[/\\])+/, ""));

    if (!target.startsWith(ROOT)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    const info = await stat(target);
    const file = info.isDirectory() ? join(target, "index.html") : target;
    const body = await readFile(file);

    res.writeHead(200, {
      "Content-Type": TYPES[extname(file)] || "application/octet-stream",
      // 开发期不缓存，便于验证 SW 的更新逻辑
      "Cache-Control": "no-cache",
      "Service-Worker-Allowed": "/"
    });
    res.end(body);
  } catch (e) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("404 Not Found");
  }
});

/** 列出本机非回环 IPv4 地址，便于在手机上访问 */
function lanAddresses() {
  const out = [];
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === "IPv4" && !net.internal) out.push({ name, address: net.address });
    }
  }
  return out;
}

server.listen(PORT, HOST, () => {
  console.log("算账稿纸 已启动（监听 " + HOST + ":" + PORT + "）");
  console.log("  本机:   http://localhost:" + PORT + "/");
  for (const { name, address } of lanAddresses()) {
    console.log("  局域网: http://" + address + ":" + PORT + "/   (" + name + ")");
  }
  console.log("按 Ctrl+C 停止");
});

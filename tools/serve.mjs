/*!
 * 算账稿纸 · 本地静态服务器（零依赖）
 * 用途：本地预览与 PWA 验证（Service Worker 需要 http 环境）
 * 用法：node tools/serve.mjs [port]
 */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

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

server.listen(PORT, () => {
  console.log("算账稿纸 已启动: http://localhost:" + PORT + "/");
  console.log("按 Ctrl+C 停止");
});

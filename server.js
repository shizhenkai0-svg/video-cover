import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const PORT = Number(process.env.PORT) || 8787;
const FETCH_TIMEOUT_MS = 14000;

const UA_DESKTOP =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const UA_MOBILE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const COVER_KEYS = [
  "origin_cover",
  "originCover",
  "dynamic_cover",
  "share_cover",
  "cover_url",
  "coverUrl",
  "thumbnailUrl",
  "thumbnail_url",
  "poster_url",
  "video_cover",
  "videoCover",
  "cover",
  "pic",
  "poster",
  "thumbUrl",
  "thumb_url",
];

const BLOCKED_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0"]);

function json(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\\u002F/g, "/")
    .replace(/\\\//g, "/");
}

function firstUrl(text) {
  const match = String(text).match(/https?:\/\/[^\s<>"'`]+/i);
  if (!match) return null;
  return match[0].replace(/[),，。；;]+$/g, "");
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip.includes("%")) ip = ip.split("%")[0];
  if (ip.startsWith("::ffff:")) ip = ip.slice(7);
  if (ip === "127.0.0.1" || ip === "::1" || ip === "0.0.0.0") return true;
  const parts = ip.split(".").map(Number);
  if (parts.length === 4 && parts.every((n) => Number.isInteger(n))) {
    const [a, b] = parts;
    if (a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return ip.startsWith("fc") || ip.startsWith("fd") || ip.startsWith("fe80");
}

async function assertPublicUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("链接格式无效");
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("只支持 http/https 链接");
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.has(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("不允许访问内网地址");
  }
  const addresses = isIP(host) ? [host] : await lookup(host, { all: true });
  for (const item of addresses) {
    const address = typeof item === "string" ? item : item.address;
    if (isPrivateIp(address)) throw new Error("不允许访问内网地址");
  }
  return url;
}

async function fetchText(url, { ua = UA_DESKTOP, accept } = {}) {
  await assertPublicUrl(url);
  const response = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: {
      "User-Agent": ua,
      Accept: accept || "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
      "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    },
  });
  return { response, text: await response.text(), finalUrl: response.url || url };
}

function metaContent(html, names) {
  const list = Array.isArray(names) ? names : [names];
  for (const name of list) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const patterns = [
      new RegExp(
        `<meta[^>]+(?:property|name|itemprop)=["']${escaped}["'][^>]*content=["']([^"']+)["']`,
        "i"
      ),
      new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]*(?:property|name|itemprop)=["']${escaped}["']`,
        "i"
      ),
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return decodeHtml(match[1]);
    }
  }
  return "";
}

function titleFromHtml(html) {
  return (
    metaContent(html, ["og:title", "twitter:title"]) ||
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || "").replace(/\s+/g, " ").trim()
  );
}

function parseLdThumbnails(html) {
  const results = [];
  const blocks = html.matchAll(
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  );
  for (const block of blocks) {
    try {
      const data = JSON.parse(block[1].trim());
      const items = Array.isArray(data) ? data : [data];
      for (const item of items) {
        const thumb = item?.thumbnailUrl || item?.image;
        if (typeof thumb === "string") results.push(thumb);
        if (Array.isArray(thumb)) results.push(...thumb.filter((x) => typeof x === "string"));
        if (thumb && typeof thumb === "object" && thumb.url) results.push(thumb.url);
      }
    } catch {
      /* ignore malformed json-ld */
    }
  }
  return results;
}

function looksLikeImage(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url);
}

function findCoverInObject(value, depth = 0) {
  if (depth > 7 || value == null) return "";
  if (typeof value === "string") {
    if (looksLikeImage(value) && /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(value)) return value;
    return "";
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findCoverInObject(item, depth + 1);
      if (found) return found;
    }
    return "";
  }
  if (typeof value === "object") {
    for (const key of COVER_KEYS) {
      const candidate = value[key];
      if (typeof candidate === "string" && looksLikeImage(candidate)) return candidate;
      if (candidate && typeof candidate === "object") {
        const nested =
          candidate.url_list?.[0]?.url ||
          candidate.url_list?.[0] ||
          candidate.url ||
          candidate.uri;
        if (typeof nested === "string" && looksLikeImage(nested)) return nested;
      }
    }
    for (const nested of Object.values(value)) {
      const found = findCoverInObject(nested, depth + 1);
      if (found) return found;
    }
  }
  return "";
}

function coversFromHtml(html) {
  const covers = [
    metaContent(html, ["og:image", "og:image:url", "twitter:image", "twitter:image:src"]),
    ...parseLdThumbnails(html),
  ].filter(Boolean);

  const renderData = html.match(
    /<script[^>]+id=["']RENDER_DATA["'][^>]*>([\s\S]*?)<\/script>/i
  );
  if (renderData?.[1]) {
    try {
      const parsed = JSON.parse(decodeURIComponent(renderData[1].trim()));
      const found = findCoverInObject(parsed);
      if (found) covers.unshift(found);
    } catch {
      /* ignore */
    }
  }

  const router = html.match(/_ROUTER_DATA\s*=\s*(\{[\s\S]*?\});/);
  if (router?.[1]) {
    try {
      const found = findCoverInObject(JSON.parse(router[1]));
      if (found) covers.unshift(found);
    } catch {
      /* ignore */
    }
  }

  return [...new Set(covers.map(decodeHtml).filter(looksLikeImage))];
}

function youtubeId(input) {
  const text = String(input).trim();
  const patterns = [
    /(?:youtube\.com\/watch\?[^#]*v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/|youtube\.com\/live\/)([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return "";
}

function biliId(input) {
  const text = String(input).trim();
  const bv = text.match(/\b(BV[0-9A-Za-z]{10})\b/);
  if (bv) return { bvid: bv[1] };
  if (/^BV[0-9A-Za-z]{10}$/.test(text)) return { bvid: text };
  if (/^av?\d{5,12}$/i.test(text)) return { aid: text.replace(/^av/i, "") };
  const aid = text.match(/\b(?:av|AV)(\d{5,12})\b/) || text.match(/\/video\/av(\d+)/i);
  if (aid) return { aid: aid[1] };
  return null;
}

async function extractYouTube(id) {
  const candidates = [
    `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
    `https://i.ytimg.com/vi/${id}/sddefault.jpg`,
    `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
  ];
  let coverUrl = candidates[2];
  for (const candidate of candidates) {
    try {
      await assertPublicUrl(candidate);
      const head = await fetch(candidate, {
        method: "HEAD",
        signal: AbortSignal.timeout(6000),
        headers: { "User-Agent": UA_DESKTOP },
      });
      if (head.ok && Number(head.headers.get("content-length") || 0) > 2000) {
        coverUrl = candidate;
        break;
      }
    } catch {
      /* try next size */
    }
  }
  return {
    platform: "YouTube",
    id,
    title: `YouTube ${id}`,
    coverUrl,
    pageUrl: `https://www.youtube.com/watch?v=${id}`,
  };
}

async function extractBilibili(ids) {
  const query = ids.bvid ? `bvid=${ids.bvid}` : `aid=${ids.aid}`;
  const { response, text } = await fetchText(
    `https://api.bilibili.com/x/web-interface/view?${query}`,
    { accept: "application/json" }
  );
  if (!response.ok) throw new Error("B站接口请求失败");
  const body = JSON.parse(text);
  if (body.code !== 0 || !body.data) throw new Error(body.message || "未找到该 B 站视频");
  return {
    platform: "哔哩哔哩",
    id: body.data.bvid || ids.bvid || ids.aid,
    title: body.data.title || "",
    author: body.data.owner?.name || "",
    coverUrl: String(body.data.pic || "").replace(/^http:\/\//, "https://"),
    pageUrl: `https://www.bilibili.com/video/${body.data.bvid || ""}`,
  };
}

function hostPlatform(url) {
  const host = (() => {
    try {
      return new URL(url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  })();
  const map = [
    [/douyin\.com|iesdouyin\.com/, "抖音"],
    [/tiktok\.com/, "TikTok"],
    [/kuaishou\.com|chenzhongtech\.com/, "快手"],
    [/xiaohongshu\.com|xhslink\.com/, "小红书"],
    [/weixin\.qq\.com|channels\.weixin/, "微信视频号"],
    [/bilibili\.com|b23\.tv/, "哔哩哔哩"],
    [/youtube\.com|youtu\.be/, "YouTube"],
    [/vimeo\.com/, "Vimeo"],
    [/weibo\.com|weibo\.cn/, "微博"],
    [/ixigua\.com/, "西瓜视频"],
  ];
  for (const [pattern, name] of map) {
    if (pattern.test(host)) return name;
  }
  return host || "网页";
}

function detectPlatform(input) {
  const text = String(input);
  if (/youtube\.com|youtu\.be/i.test(text) || youtubeId(text)) return "YouTube";
  if (/bilibili\.com|b23\.tv|\bBV[0-9A-Za-z]{10}\b|^av\d+/i.test(text)) return "哔哩哔哩";
  if (/douyin\.com|iesdouyin\.com/i.test(text)) return "抖音";
  if (/tiktok\.com/i.test(text)) return "TikTok";
  if (/kuaishou\.com|v\.kuaishou/i.test(text)) return "快手";
  if (/xiaohongshu\.com|xhslink\.com/i.test(text)) return "小红书";
  if (/weixin\.qq\.com|channels\.weixin/i.test(text)) return "微信视频号";
  if (/weibo\.com|weibo\.cn/i.test(text)) return "微博";
  return "";
}

async function extractFromPage(url, platformHint) {
  let lastError = null;
  for (const ua of [UA_MOBILE, UA_DESKTOP]) {
    try {
      const { text, finalUrl } = await fetchText(url, { ua });
      const covers = coversFromHtml(text);
      if (covers[0]) {
        return {
          platform: platformHint || hostPlatform(finalUrl),
          title: titleFromHtml(text) || "未命名视频",
          coverUrl: covers[0],
          pageUrl: finalUrl,
        };
      }
      lastError = new Error("页面中没有找到封面");
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("提取失败");
}

function isDirectMedia(url) {
  return /\.(mp4|webm|mov|m4v|mkv|avi)(\?|$)/i.test(url);
}

async function extract(input) {
  const raw = String(input || "").trim();
  if (!raw) throw new Error("请输入视频链接或视频号");

  const url = firstUrl(raw);

  if (/^[a-zA-Z0-9_-]{11}$/.test(raw)) return extractYouTube(raw);
  if (/^BV[0-9A-Za-z]{10}$/.test(raw)) return extractBilibili({ bvid: raw });
  if (/^av?\d{5,12}$/i.test(raw)) return extractBilibili({ aid: raw.replace(/^av/i, "") });

  const yt = youtubeId(url || raw);
  if (yt && (!url || /youtube|youtu\.be/i.test(url))) return extractYouTube(yt);

  const bili = biliId(url || raw);
  if (bili && (!url || /bilibili|b23\.tv/i.test(url))) {
    if (url && /b23\.tv/i.test(url)) {
      const { finalUrl } = await fetchText(url);
      const resolved = biliId(finalUrl);
      if (resolved) return extractBilibili(resolved);
    }
    return extractBilibili(bili);
  }

  if (!url) {
    throw new Error(
      "无法识别该视频号。请粘贴完整分享链接，或使用 YouTube 11 位 ID、B 站 BV/av 号。"
    );
  }

  const platform = detectPlatform(url) || hostPlatform(url);
  if (isDirectMedia(url)) {
    return {
      platform: "直链视频",
      title: decodeURIComponent(url.split("/").pop() || "视频"),
      coverUrl: "",
      pageUrl: url,
      videoUrl: url,
      extractFrame: true,
    };
  }

  return extractFromPage(url, platform);
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let filePath = path.normalize(
    path.join(PUBLIC_DIR, url.pathname === "/" ? "/index.html" : url.pathname)
  );
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not Found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(data);
  });
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return Object.fromEntries(new URLSearchParams(raw));
  }
}

async function proxyMedia(req, res, rawUrl, asDownload) {
  const target = await assertPublicUrl(rawUrl);
  const incoming = await fetch(target, {
    redirect: "follow",
    signal: AbortSignal.timeout(20000),
    headers: {
      "User-Agent": UA_DESKTOP,
      Accept: "image/avif,image/webp,image/*,video/*,*/*;q=0.8",
    },
  });
  if (!incoming.ok) {
    json(res, 502, { ok: false, error: "封面资源获取失败" });
    return;
  }
  const type = incoming.headers.get("content-type") || "application/octet-stream";
  const headers = {
    "Content-Type": type,
    "Cache-Control": "public, max-age=3600",
  };
  if (asDownload) {
    const ext = type.includes("png") ? "png" : type.includes("webp") ? "webp" : "jpg";
    headers["Content-Disposition"] = `attachment; filename="video-cover.${ext}"`;
  }
  res.writeHead(200, headers);
  res.end(Buffer.from(await incoming.arrayBuffer()));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (req.method === "POST" && url.pathname === "/api/extract") {
      const body = await readBody(req);
      json(res, 200, { ok: true, ...(await extract(body.input || body.url || "")) });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/image") {
      await proxyMedia(req, res, url.searchParams.get("url") || "", false);
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/download") {
      await proxyMedia(req, res, url.searchParams.get("url") || "", true);
      return;
    }
    if (req.method === "GET" || req.method === "HEAD") {
      serveStatic(req, res);
      return;
    }
    json(res, 405, { ok: false, error: "Method Not Allowed" });
  } catch (error) {
    json(res, 400, { ok: false, error: error.message || "提取失败" });
  }
});

server.listen(PORT, () => {
  console.log(`Video cover extractor running at http://127.0.0.1:${PORT}`);
});

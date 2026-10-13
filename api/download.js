import { proxyMedia, json } from "../lib/core.js";

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://localhost");
    await proxyMedia(req, res, url.searchParams.get("url") || "", true);
  } catch (error) {
    json(res, 400, { ok: false, error: error.message || "获取失败" });
  }
}

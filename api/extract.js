import { extract, readBody, json } from "../lib/core.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      json(res, 405, { ok: false, error: "Method Not Allowed" });
      return;
    }
    const body = await readBody(req);
    const result = await extract(body.input || body.url || "");
    json(res, 200, { ok: true, ...result });
  } catch (error) {
    json(res, 400, { ok: false, error: error.message || "提取失败" });
  }
}

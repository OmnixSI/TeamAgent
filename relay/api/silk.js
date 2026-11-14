// SILK voice codec for QQ. The encoder builds functions at run time, which Cloudflare Workers forbid,
// so it lives here beside the fetch relay. Same shared key.
import { decode, encode } from "silk-wasm";

export const config = { maxDuration: 30 };

export default async function handler(req, res) {
  const key = process.env.RELAY_KEY;
  if (!key || req.headers["x-relay-key"] !== key) return res.status(401).json({ error: "unauthorized" });
  const { op, data, rate = 24000 } = req.body || {};
  if (!data || (op !== "encode" && op !== "decode")) return res.status(400).json({ error: "op and data required" });
  try {
    const input = Buffer.from(String(data), "base64");
    const out = op === "encode" ? await encode(input, Number(rate)) : await decode(input, Number(rate));
    return res.status(200).json({ data: Buffer.from(out.data).toString("base64"), duration: out.duration });
  } catch (e) {
    return res.status(200).json({ error: String(e?.message || e).slice(0, 200) });
  }
}

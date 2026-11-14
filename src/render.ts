// Headless browser on Cloudflare: pages to pictures and PDFs. The plan includes ten browser hours a
// month, so every session is timed and rendering stops before the allowance runs out.
import puppeteer from "@cloudflare/puppeteer";
import type { Hub } from "./hub.ts";
import { sleep } from "./util.ts";

export type Shot = { html: string; width: number; height: number; full: boolean; selector?: string; settle: number; maxHeight?: number };

async function session<T>(hub: Hub, work: (tab: any) => Promise<T>): Promise<T> {
  if (!hub.plan.fits("browser_seconds", 20)) throw new Error("这个月无头浏览器的额度用到停止线了（套餐内每月 10 小时），下个周期才能再渲染");
  const started = Date.now();
  const browser = await puppeteer.launch(hub.env.BROWSER);
  try { return await work(await browser.newPage()); }
  finally {
    await browser.close().catch(() => {});
    hub.plan.add("browser_seconds", (Date.now() - started) / 1000 + 1);
  }
}

export function render(hub: Hub, page: Shot) {
  return session(hub, async tab => {
    const shoot = async (scale: number, quality: number) => {
      await tab.setViewport({ width: page.width, height: page.height, deviceScaleFactor: scale });
      await tab.setContent(page.html, { waitUntil: "networkidle0", timeout: 25000 }).catch(() => {});
      await sleep(page.settle);
      let clipBox: any, truncated = false;
      if (page.selector) {
        const box = await (await tab.$(page.selector))?.boundingBox();
        if (box && box.width > 120 && box.height > 80) clipBox = { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.min(Math.ceil(box.width), 3200), height: Math.min(Math.ceil(box.height), 7000) };
      }
      if (!clipBox && page.full) {
        const h = Number(await tab.evaluate("document.documentElement.scrollHeight")), cap = page.maxHeight || 7000;
        truncated = h > cap;
        clipBox = { x: 0, y: 0, width: page.width, height: Math.min(h, cap) };
      }
      const shot = await tab.screenshot({ type: "jpeg", quality, ...(clipBox ? { clip: clipBox } : {}) });
      return { bytes: new Uint8Array(shot as ArrayBuffer), truncated };
    };
    let out = await shoot(2, 86);
    if (out.bytes.length > 3_500_000) out = await shoot(1, 80);   // very long pages: trade sharpness for a size QQ accepts
    return out;
  });
}

/** Prints a page-laid-out document to PDF; `width`/`height` are the page size in CSS pixels. */
export function renderPdf(hub: Hub, html: string, width: number, height: number) {
  return session(hub, async tab => {
    await tab.setViewport({ width, height, deviceScaleFactor: 1 });
    await tab.setContent(html, { waitUntil: "networkidle0", timeout: 40000 }).catch(() => {});
    await sleep(600);
    const pdf = await tab.pdf({ width: width + "px", height: height + "px", printBackground: true, preferCSSPageSize: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    return new Uint8Array(pdf as ArrayBuffer);
  });
}

/** Opens a real page in the browser: its text after scripts have run, and optionally a screenshot. */
export function browse(hub: Hub, url: string, wantShot: boolean) {
  return session(hub, async tab => {
    await tab.setViewport({ width: 1280, height: 900, deviceScaleFactor: 1 });
    await tab.goto(url, { waitUntil: "networkidle2", timeout: 30000 }).catch(() => {});
    await sleep(800);
    const title = String(await tab.title().catch(() => ""));
    const text = String(await tab.evaluate("document.body ? document.body.innerText : ''").catch(() => ""));
    const shot = wantShot ? new Uint8Array((await tab.screenshot({ type: "jpeg", quality: 72 })) as ArrayBuffer) : null;
    return { title, text, shot };
  });
}

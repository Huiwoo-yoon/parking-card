/* 주차 연락 카드 서버 (Cloudflare Worker)
   - POST /send?c=car1  { message, phone, urgent } : 차주에게 알림. 급하면 전화벨처럼 반복
   - GET  /stop?c=car1                             : 반복 멈춤 (알림을 누르면 열리는 주소)
   알림 받을 키는 cars.js 에 있음 (git 에 올리지 않는 파일). 고친 뒤엔 npx wrangler deploy */
import { DurableObject } from "cloudflare:workers";
import { CARS } from "./cars.js";

const PAGE_ORIGIN = "https://huiwoo-yoon.github.io";
const BARK_SERVER = "https://api.day.app";
const NTFY_SERVER = "https://ntfy.sh";
const COOLDOWN_SEC = 60;       // 차량별. 누가 보내든 이 시간 안에는 다시 못 보냄
const REPEAT_SEC = 60;         // 급한 요청을 반복하는 시간
const REPEAT_EVERY_SEC = 3;

const CORS = {
  "Access-Control-Allow-Origin": PAGE_ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const json = (data, status = 200) => Response.json(data, { status, headers: CORS });

export default {
  async fetch(req, env) {
    if (req.method === "OPTIONS") return new Response(null, { headers: CORS });
    const url = new URL(req.url);
    const carKey = url.searchParams.get("c");
    if (!CARS[carKey]) return json({ error: "unknown car" }, 404);
    const ringer = env.RINGER.get(env.RINGER.idFromName(carKey));

    if (url.pathname === "/send" && req.method === "POST") {
      const { message, phone, urgent } = await req.json();
      if (typeof message !== "string" || !message.trim()) return json({ error: "empty message" }, 400);
      const text = message.trim().slice(0, 200) + (phone ? "\n회신 연락처: " + String(phone).slice(0, 20) : "");
      const stopUrl = url.origin + "/stop?c=" + encodeURIComponent(carKey);
      const result = await ringer.start(carKey, text, !!urgent, stopUrl);
      return json(result, result.ok ? 200 : result.wait ? 429 : 502);
    }
    if (url.pathname === "/stop") {
      await ringer.stop();
      return new Response(
        '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>주차 연락</title><body style="font:20px/1.5 system-ui;text-align:center;padding:25vh 16px">알림을 멈췄어요.',
        { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
    return json({ error: "not found" }, 404);
  },
};

// 차량의 모든 수신자에게 한 번 보냄
async function push({ carKey, text, urgent, stopUrl }) {
  const car = CARS[carKey];
  const title = (car.plate ? car.plate + " · " : "") + "주차 연락";
  const results = await Promise.all(car.keys.map(entry => {
    // 안드로이드 (ntfy): 급한 요청은 최고 우선순위(5)
    if (typeof entry === "object" && entry.ntfy) {
      const body = { topic: entry.ntfy, title, message: text, priority: urgent ? 5 : 4, tags: [urgent ? "rotating_light" : "car"] };
      if (urgent) body.click = stopUrl;
      return fetch(NTFY_SERVER + "/", { method: "POST", body: JSON.stringify(body) });
    }
    const k = typeof entry === "string" ? entry : entry.key;
    // critical: false 인 사람은 무음·집중 모드를 뚫지 않음 (집중 모드 설정을 따름)
    const critical = urgent && !(typeof entry === "object" && entry.critical === false);
    const p = new URLSearchParams({
      title, body: text, group: "주차 연락",
      level: critical ? "critical" : "timeSensitive",
      volume: critical ? "10" : "5",
    });
    if (urgent) p.set("url", stopUrl);   // 알림을 누르면 반복이 멈춤
    return fetch(BARK_SERVER + "/" + encodeURIComponent(k), { method: "POST", body: p });
  }));
  if (!results.some(r => r.ok)) throw new Error("push failed");
}

// 차량마다 하나씩. 쿨다운과 반복 전송(알람)을 맡음
export class Ringer extends DurableObject {
  async start(carKey, text, urgent, stopUrl) {
    const now = Date.now();
    const last = (await this.ctx.storage.get("last")) || 0;
    const wait = Math.ceil((last + COOLDOWN_SEC * 1000 - now) / 1000);
    if (wait > 0) return { ok: false, wait };
    const job = { carKey, text, urgent, stopUrl, until: now + REPEAT_SEC * 1000 };
    try { await push(job); } catch (e) { return { ok: false }; }
    await this.ctx.storage.put("last", now);
    if (urgent) {
      await this.ctx.storage.put("job", job);
      await this.ctx.storage.setAlarm(now + REPEAT_EVERY_SEC * 1000);
    }
    return { ok: true, repeat: urgent ? REPEAT_SEC : 0 };
  }

  async stop() {
    await this.ctx.storage.delete("job");
    await this.ctx.storage.deleteAlarm();
  }

  async alarm() {
    const job = await this.ctx.storage.get("job");
    if (!job || Date.now() >= job.until) { await this.ctx.storage.delete("job"); return; }
    try { await push(job); } catch (e) {}
    await this.ctx.storage.setAlarm(Date.now() + REPEAT_EVERY_SEC * 1000);
  }
}

import express from "express";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { SERPAPI_KEY, GEMINI_API_KEY, PORT = 3000 } = process.env;
const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const DEMO = process.env.DEMO_MODE === "true";
const ENABLED = (process.env.PROVIDERS || "serpapi").split(",").map(x => x.trim());
const app = express();
app.set("trust proxy", 1);
const hits = new Map();

const limiter = (req, res, next) => {
  const k = req.ip, now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < 60000);
  if (a.length >= 20) return res.status(429).json({ error: "طلبات كثيرة، انتظر دقيقة ثم حاول مرة أخرى." });
  a.push(now); hits.set(k, a); next();
};
setInterval(() => { const n = Date.now(); for (const [k, a] of hits) if (!a.some(t => n - t < 60000)) hits.delete(k); }, 60000).unref();

app.get("/health", (_, res) => res.json({ ok: true }));
app.get("/api/config", (_, res) => res.json({ demo: DEMO, ai: !!GEMINI_API_KEY, search: DEMO || !!SERPAPI_KEY }));
app.use(express.json({ limit: "1mb" }));
app.use("/api", (req, res, next) => req.path === "/config" ? next() : limiter(req, res, next));
app.use(express.static(path.join(__dirname, "public")));

/* ---------- الذكاء الاصطناعي (Google Gemini) ---------- */
// ترجع النص، أو null عند أي فشل (لا ترمي أخطاء أبداً)
async function ai(system, messages, maxTokens = 1000) {
  if (!GEMINI_API_KEY) return null;
  try {
    const msgs = typeof messages === "string" ? [{ role: "user", content: messages }] : messages;
    const body = {
      contents: msgs.map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content) }] })),
      generationConfig: { maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } },
    };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) {
      console.error("Gemini API Error", r.status, await r.text().catch(() => ""));
      return null;
    }
    const d = await r.json();
    const text = (d.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
    if (!text) console.error("Gemini empty response:", JSON.stringify(d).slice(0, 500));
    return text || null;
  } catch (e) {
    console.error("AI call failed:", e?.message || e);
    return null;
  }
}
const json = t => {
  if (!t) return null;
  try { return JSON.parse(t.replace(/```json|```/g, "").trim()); } catch {}
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch {} }
  return null;
};

/* ---------- مصادر البحث ---------- */
const DOMAINS = { sa: "google.com.sa", ae: "google.ae", kw: "google.com.kw", eg: "google.com.eg" };
const CUR = { sa: "SAR", ae: "AED", kw: "KWD", eg: "EGP" };
const providers = {
  async demo() {
    const base = [["Apple AirPods Pro 2 USB-C", 899, 0, 4.8, 1200], ["Apple AirPods Pro 2 USB-C", 929, 15, 4.7, 310], ["Apple AirPods 4", 649, 0, 4.6, 540]];
    return base.map(b => ({ title: b[0], store: "متجر تجريبي", price: b[1], shipping: b[2], rating: b[3], reviews: b[4], image: null, link: "https://example.com/demo", description: "بيانات تجريبية", condition: "new", currency: "SAR", demo: true }));
  },
  async serpapi(query, { country }) {
    if (!SERPAPI_KEY) throw new Error("NO_SERPAPI_KEY");
    const u = new URL("https://serpapi.com/search.json");
    u.search = new URLSearchParams({ engine: "google_shopping", q: query, gl: country, hl: "ar", google_domain: DOMAINS[country] || "google.com", num: "40", api_key: SERPAPI_KEY });
    const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error("SERPAPI " + r.status);
    const d = await r.json();
    return (d.shopping_results || []).map(p => ({
      title: p.title, store: p.source || null, price: p.extracted_price ?? null, currency: CUR[country] || null,
      shipping: /مجان|free/i.test(p.delivery || "") ? 0 : (p.delivery_price ?? null),
      rating: p.rating ?? null, reviews: p.reviews ?? null, image: p.thumbnail || null,
      link: p.product_link || p.link || null, description: p.snippet || null,
      condition: /second|used|مستعمل/i.test(p.second_hand_condition || "") ? "used" : "new",
      availability: null,
    }));
  },
};

/* ---------- /api/search ---------- */
app.post("/api/search", async (req, res) => {
  const { q = "", country = "sa", maxPrice, store, condition } = req.body || {};
  if (!String(q).trim()) return res.status(400).json({ error: "اكتب اسم المنتج أولاً." });
  try {
    let intent = { query: q, maxPrice: null };
    if (!DEMO) {
      const t = await ai('أنت مساعد تسوق. استخرج من طلب المستخدم عبارة البحث كـ JSON فقط بدون أي نص آخر بالصيغة: {"query":"اسم المنتج المصفى","maxPrice":رقم أو null}', String(q), 200);
      const j = json(t);
      if (j?.query) intent = j;
    }
    const budget = Number(maxPrice) || Number(intent.maxPrice) || null;

    let items = [];
    const active = DEMO ? ["demo"] : ENABLED;
    for (const name of active) {
      const fn = providers[name]; if (!fn) continue;
      try {
        const list = await fn(intent.query || q, { country });
        items.push(...list.map(i => ({ ...i, source: name })));
      } catch (e) { console.error(`provider ${name} failed:`, e?.message || e); }
    }
    items = items.filter(i => i.title && i.link && i.price > 0);

    items.forEach(i => { i.total = i.shipping != null ? i.price + i.shipping : i.price; });
    if (budget) items = items.filter(i => i.total <= budget);
    if (store) items = items.filter(i => (i.store || "").toLowerCase().includes(String(store).toLowerCase()));
    if (condition) items = items.filter(i => i.condition === condition);

    items.sort((a, b) => a.total - b.total);
    items = items.slice(0, 10).map((i, n) => ({ ...i, id: Date.now() + "-" + n }));

    res.json({ demo: DEMO, query: q, understood: intent, budget, dropped: 0, updatedAt: new Date().toISOString(), results: items });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "تعذّر جلب النتائج، حاول مرة أخرى." });
  }
});

const SYS = "أنت مساعد تسوق باللغة العربية (لهجة سعودية بسيطة). اعتمد حصراً على بيانات النتائج المرفقة، ولا تخترع مواصفات أو أسعاراً.";
const brief = r => (Array.isArray(r) ? r : []).map((i, n) => `#${n + 1} | ${i.title} | ${i.store || "متجر"} | ${i.price} ${i.currency || "SAR"}`).join("\n");

/* ---------- /api/chat ---------- */
app.post("/api/chat", async (req, res) => {
  try {
    const { messages = [], results = [] } = req.body || {};
    if (!GEMINI_API_KEY) return res.json({ reply: "خدمة الذكاء الاصطناعي غير مفعّلة حالياً." });

    // نظّف سجل المحادثة: يجب أن يبدأ برسالة user وتتناوب الأدوار
    const clean = [];
    for (const m of Array.isArray(messages) ? messages.slice(-10) : []) {
      const role = m?.role === "assistant" ? "assistant" : "user";
      const content = String(m?.content ?? "").trim();
      if (!content) continue;
      if (clean.length && clean[clean.length - 1].role === role) clean[clean.length - 1].content += "\n" + content;
      else clean.push({ role, content });
    }
    while (clean.length && clean[0].role !== "user") clean.shift();
    if (!clean.length) clean.push({ role: "user", content: "مرحباً" });

    const system = `${SYS}\n\nنتائج البحث الحالية:\n${brief(results.slice(0, 5)) || "لا توجد نتائج."}`;
    const reply = await ai(system, clean, 800);
    res.json({ reply: reply || "عذراً، تعذّر الرد حالياً. حاول مرة ثانية." });
  } catch (e) {
    console.error(e);
    res.json({ reply: "عذراً، تعذّر الرد حالياً. حاول مرة ثانية." });
  }
});

/* ---------- /api/compare ---------- */
app.post("/api/compare", async (req, res) => {
  const fail = { items: [], verdict: "تعذّر تحليل المقارنة حالياً." };
  try {
    if (!GEMINI_API_KEY) return res.json(fail);
    const items = (Array.isArray(req.body?.items) ? req.body.items : []).slice(0, 4);
    if (!items.length) return res.json(fail);
    const prompt = `قارن بين المنتجات التالية وأعد النتيجة كـ JSON فقط بدون أي نص إضافي بالصيغة: {"items":[{"pros":["..."],"cons":["..."],"specs":"..."}],"verdict":"أفضل خيار"} (عنصر واحد لكل منتج بنفس الترتيب)\n\n${brief(items)}`;
    const t = await ai(SYS, prompt, 1200);
    res.json(json(t) || fail);
  } catch (e) {
    console.error(e);
    res.json(fail);
  }
});

// شبكة أمان أخيرة
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: "حدث خطأ غير متوقع." });
});
process.on("unhandledRejection", e => console.error("unhandledRejection:", e));
process.on("uncaughtException", e => console.error("uncaughtException:", e));

app.listen(PORT, "0.0.0.0", () => console.log("لقطة تعمل على http://localhost:" + PORT));

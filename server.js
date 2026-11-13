import express from "express";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { SERPAPI_KEY, GEMINI_API_KEY, PORT = 3000 } = process.env;
const MODEL = "gemini-2.5-flash";
const DEMO = process.env.DEMO_MODE === "true";
const ENABLED = (process.env.PROVIDERS || "serpapi").split(",").map(x => x.trim());
const app = express();
app.set("trust proxy", 1);
const hits = new Map(), cache = new Map();
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

/* ---------- الذكاء الاصطناعي (Google Gemini المبسط) ---------- */
async function ai(systemPrompt, userPrompt) {
  if (!GEMINI_API_KEY) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  
  const payload = {
    contents: [
      { role: "user", parts: [{ text: (systemPrompt ? systemPrompt + "\n\n" : "") + (typeof userPrompt === "string" ? userPrompt : JSON.stringify(userPrompt)) }] }
    ]
  };

  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  
  if (!r.ok) {
    const errText = await r.text();
    console.error("Gemini API Error:", errText);
    throw new Error("Gemini API Error " + r.status);
  }
  
  const d = await r.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text || null;
}
const json = t => { try { return JSON.parse(t.replace(/```json|```/g, "").trim()); } catch { return null; } };

/* ---------- مصادر البحث ---------- */
const DOMAINS = { sa: "google.com.sa", ae: "google.ae", kw: "google.com.kw", eg: "google.com.eg" };
const CUR = { sa: "SAR", ae: "AED", kw: "KWD", eg: "EGP" };
const providers = {
  async demo(query) {
    const base = [["Apple AirPods Pro 2 USB-C", 899, 0, 4.8, 1200], ["Apple AirPods Pro 2 USB-C", 929, 15, 4.7, 310], ["Apple AirPods 4", 649, 0, 4.6, 540]];
    return base.map(b => ({ title: b[0], store: "متجر تجريبي", price: b[1], shipping: b[2], rating: b[3], reviews: b[4], image: null, link: "https://example.com/demo", description: "بيانات تجريبية", condition: "new", currency: "SAR", demo: true }));
  },
  async serpapi(query, { country }) {
    if (!SERPAPI_KEY) throw new Error("NO_SERPAPI_KEY");
    const u = new URL("https://serpapi.com/search.json");
    u.search = new URLSearchParams({ engine: "google_shopping", q: query, gl: country, hl: "ar", google_domain: DOMAINS[country] || "google.com", num: "40", api_key: SERPAPI_KEY });
    const r = await fetch(u);
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
  const { q = "", country = "sa", maxPrice, store, condition, sort = "price" } = req.body || {};
  if (!q.trim()) return res.status(400).json({ error: "اكتب اسم المنتج أولاً." });
  try {
    let intent = { query: q, maxPrice: null };
    if (!DEMO) try {
      const t = await ai('أنت مساعد تسوق. استخرج من طلب المستخدم عبارة البحث كـ JSON فقط بالصيغة: {"query":"اسم المنتج المصفى","maxPrice":رقم أو null}', q);
      const j = t && json(t); if (j?.query) intent = j;
    } catch {}
    const budget = Number(maxPrice) || Number(intent.maxPrice) || null;

    let items = [];
    const active = DEMO ? ["demo"] : ENABLED;
    for (const name of active) { const fn = providers[name]; if (!fn) continue; items.push(...(await fn(intent.query || q, { country })).map(i => ({ ...i, source: name }))); }
    items = items.filter(i => i.title && i.link && i.price > 0);

    items.forEach(i => { i.total = i.shipping != null ? i.price + i.shipping : i.price; });
    if (budget) items = items.filter(i => i.total <= budget);
    if (store) items = items.filter(i => (i.store || "").toLowerCase().includes(store.toLowerCase()));
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
const brief = r => (r || []).map((i, n) => `#${n + 1} | ${i.title} | ${i.store || "متجر"} | ${i.price} ${i.currency || "SAR"}`).join("\n");

/* ---------- /api/chat ---------- */
app.post("/api/chat", async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: "مفتاح GEMINI_API_KEY غير مضاف." });
  try {
    const { messages = [], results = [] } = req.body;
    const lastUserMsg = messages.filter(m => m.role === "user").pop()?.content || "مرحباً";
    const prompt = `${SYS}\n\nنتائج البحث الحالية:\n${brief(results.slice(0, 5))}\n\nسؤال المستخدم: ${lastUserMsg}`;
    const reply = await ai("", prompt);
    res.json({ reply: reply || "عذراً، لم أتمكن من الرد." });
  } catch (e) { console.error(e); res.status(500).json({ error: "تعذّر الرد الآن." }); }
});

/* ---------- /api/compare ---------- */
app.post("/api/compare", async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: "مفتاح GEMINI_API_KEY غير مضاف." });
  try {
    const items = (req.body.items || []).slice(0, 4);
    const prompt = `قارن بين المنتجات التالية وأعد النتيجة كـ JSON فقط بالصيغة: {"items":[{"pros":["..."],"cons":["..."],"specs":"..."}],"verdict":"أفضل خيار"}\n\n${brief(items)}`;
    const t = await ai("", prompt);
    res.json(json(t) || { items: [], verdict: "تعذّر تحليل المقارنة." });
  } catch (e) { console.error(e); res.status(500).json({ error: "تعذّرت المقارنة الآن." }); }
});

app.listen(PORT, "0.0.0.0", () => console.log("لقطة تعمل على http://localhost:" + PORT));

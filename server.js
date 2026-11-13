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

/* ---------- الذكاء الاصطناعي (Google Gemini) ---------- */
async function ai(system, user, maxTokens = 1200) {
  if (!GEMINI_API_KEY) return null;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_API_KEY}`;
  
  const contents = [];
  if (system) {
    contents.push({ role: "user", parts: [{ text: "تعليمات النظام الأساسية:\n" + system }] });
    contents.push({ role: "model", parts: [{ text: "حسناً، فهمت التعليمات وسألتزم بها." }] });
  }
  
  if (Array.isArray(user)) {
    for (const m of user) {
      contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content) }] });
    }
  } else {
    contents.push({ role: "user", parts: [{ text: String(user) }] });
  }

  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ contents, generationConfig: { maxOutputTokens: maxTokens } }),
  });
  
  if (!r.ok) {
    const errText = await r.text();
    throw new Error("Gemini API Error " + r.status + ": " + errText);
  }
  
  const d = await r.json();
  return d.candidates?.[0]?.content?.parts?.[0]?.text || null;
}
const json = t => { try { return JSON.parse(t.replace(/```json|```/g, "").trim()); } catch { return null; } };

/* ---------- مصادر البحث ---------- */
const DOMAINS = { sa: "google.com.sa", ae: "google.ae", kw: "google.com.kw", eg: "google.com.eg" };
const LOCS = { sa: "Saudi Arabia", ae: "United Arab Emirates", kw: "Kuwait", eg: "Egypt" };
const CUR = { sa: "SAR", ae: "AED", kw: "KWD", eg: "EGP" };
const providers = {
  async demo(query) {
    const base = [["Apple AirPods Pro 2 USB-C", 899, 0, 4.8, 1200], ["Apple AirPods Pro 2 USB-C", 929, 15, 4.7, 310], ["Apple AirPods 4", 649, 0, 4.6, 540], ["Apple AirPods 3", 589, 20, 4.5, 880], ["Samsung Galaxy Buds2 Pro", 459, 0, 4.4, 410], ["Anker Soundcore Q30", 199, 0, 4.4, 2100]];
    const w = query.toLowerCase().split(/\s+/).filter(Boolean);
    return base.filter(b => w.every(x => b[0].toLowerCase().includes(x))).map(b => ({ title: b[0], store: "متجر تجريبي", price: b[1], shipping: b[2], rating: b[3], reviews: b[4], image: null, link: "https://example.com/demo", description: "بيانات تجريبية للتطوير فقط", condition: "new", availability: null, currency: "SAR", demo: true }));
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
      link: p.product_link || p.link || null, description: p.snippet || (p.extensions || []).join("، ") || null,
      condition: /second|used|مستعمل/i.test(p.second_hand_condition || (p.extensions || []).join(" ")) ? "used" : "new",
      availability: null,
    }));
  },
};

/* ---------- /api/search ---------- */
app.post("/api/search", async (req, res) => {
  const { q = "", country = "sa", maxPrice, store, condition, sort = "price" } = req.body || {};
  if (!q.trim()) return res.status(400).json({ error: "اكتب اسم المنتج أولاً." });
  try {
    let intent = { query: q, maxPrice: null, notes: "" };
    if (!DEMO) try {
      const t = await ai(
        'حوّل طلب المتسوق إلى JSON فقط بلا أي شرح: {"query":"عبارة بحث دقيقة مناسبة لمتاجر التسوق بالاسم والموديل","maxPrice":رقم أو null,"notes":"شروط أو احتياجات مذكورة"}. لا تضف مواصفات لم يذكرها.',
        q, 300);
      const j = t && json(t); if (j?.query) intent = j;
    } catch {}
    const budget = Number(maxPrice) || Number(intent.maxPrice) || null;

    const ck = JSON.stringify([intent.query, country, DEMO, ENABLED]);
    const hit = cache.get(ck);
    let items;
    if (hit && Date.now() - hit.t < 600000) items = hit.items.map(i => ({ ...i }));
    else {
      items = [];
      const active = DEMO ? ["demo"] : ENABLED;
      for (const name of active) { const fn = providers[name]; if (!fn) continue; items.push(...(await fn(intent.query, { country })).map(i => ({ ...i, source: name }))); }
      items = items.filter(i => i.title && i.link && i.price > 0);
      cache.set(ck, { t: Date.now(), items: items.map(i => ({ ...i })) });
      if (cache.size > 200) cache.delete(cache.keys().next().value);
    }

    items.forEach(i => { i.total = i.shipping != null ? i.price + i.shipping : i.price; });
    if (budget) items = items.filter(i => i.total <= budget);
    if (store) items = items.filter(i => (i.store || "").toLowerCase().includes(store.toLowerCase()));
    if (condition) items = items.filter(i => i.condition === condition);

    let dropped = 0;
    if (!DEMO && GEMINI_API_KEY && items.length) {
      try {
        const list = items.map((i, n) => `${n}: ${i.title}`).join("\n");
        const t = await ai(
          'أنت مدقق مطابقة. المطلوب: "' + q + '" (بحث: "' + intent.query + '"). من القائمة أعد JSON فقط: {"keep":[أرقام العناصر المطابقة فعلاً للمنتج والموديل والإصدار المطلوب]}. استبعد الإكسسوارات والأغطية والموديلات والإصدارات المختلفة وقطع الغيار.',
          list, 800);
        const keep = json(t)?.keep;
        if (Array.isArray(keep)) { const s = new Set(keep); const before = items.length; items = items.filter((_, n) => s.has(n)); dropped = before - items.length; }
      } catch {}
    }

    items.sort((a, b) => a.total - b.total);
    const seen = new Set();
    items = items.filter(i => { const k = (i.store || "") + "|" + i.title.toLowerCase().replace(/\s+/g, " "); if (seen.has(k)) return false; seen.add(k); return true; });
    if (sort === "rating") items.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || a.total - b.total);
    items = items.slice(0, 10).map((i, n) => ({ ...i, id: Date.now() + "-" + n }));

    res.json({ demo: DEMO, query: q, understood: intent, budget, dropped, updatedAt: new Date().toISOString(), results: items });
  } catch (e) {
    const msg = e.message === "NO_SERPAPI_KEY" ? "مفتاح SERPAPI_KEY غير مضاف في إعدادات الخادم."
      : /SERPAPI 401/.test(e.message) ? "مفتاح SerpApi غير صحيح. راجع قيمة SERPAPI_KEY."
      : /SERPAPI 429/.test(e.message) ? "انتهى رصيد SerpApi أو تجاوزت الحد. راجع حسابك في serpapi.com."
      : "تعذّر جلب النتائج الآن، حاول مرة أخرى.";
    console.error(e);
    res.status(500).json({ error: msg });
  }
});

const SYS = "أنت مساعد تسوق باللغة العربية (لهجة سعودية بسيطة). اعتمد حصراً على بيانات النتائج المرفقة، ولا تخترع مواصفات أو أسعاراً. إذا لم تتوفر المعلومة قل: غير متوفر. اذكر رقم الخيار عند الإشارة لمنتج. كن مختصراً.";
const brief = r => (r || []).map((i, n) => `#${n + 1} | ${i.title} | ${i.store || "غير متوفر"} | ${i.price} ${i.currency || "SAR"} | شحن: ${i.shipping ?? "غير متوفر"} | تقييم: ${i.rating ?? "غير متوفر"} (${i.reviews ?? "؟"}) | ${i.description || ""}`).join("\n");

/* ---------- /api/chat ---------- */
app.post("/api/chat", async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: "مفتاح GEMINI_API_KEY غير مضاف." });
  try {
    const { messages = [], results = [] } = req.body;
    let msgs = messages.slice(-10).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content).slice(0, 2000) }));
    while (msgs.length && msgs[0].role !== "user") msgs.shift();
    if (!msgs.length) return res.status(400).json({ error: "اكتب سؤالك." });
    res.json({ reply: await ai(SYS + "\n\nنتائج البحث الحالية:\n" + brief(results.slice(0, 10)), msgs, 900) });
  } catch (e) { console.error(e); res.status(500).json({ error: "تعذّر الرد الآن." }); }
});

/* ---------- /api/compare ---------- */
app.post("/api/compare", async (req, res) => {
  if (!GEMINI_API_KEY) return res.status(500).json({ error: "مفتاح GEMINI_API_KEY غير مضاف." });
  try {
    const items = (req.body.items || []).slice(0, 4);
    const t = await ai(SYS + ' أعد JSON فقط: {"items":[{"pros":["..."],"cons":["..."],"specs":"ملخص مواصفات من البيانات فقط"}],"verdict":"أفضل خيار ولماذا (أفضل قيمة مقابل السعر)"} بنفس ترتيب العناصر.', brief(items), 1200);
    res.json(json(t) || { items: [], verdict: "تعذّر تحليل المقارنة." });
  } catch (e) { console.error(e); res.status(500).json({ error: "تعذّرت المقارنة الآن." }); }
});

app.listen(PORT, "0.0.0.0", () => console.log("لقطة تعمل على http://localhost:" + PORT));

/* IIP dashboard — reads/writes Supabase only (spec §7). Magic-link auth; RLS keeps
   data private to the owner. Tabs: Candidates, Bitcoin, Analyzer, Trades, Portfolio,
   Scorecard, Settings. */

const cfg = window.IIP_CONFIG;
const sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

// ---------- format helpers ----------
const money = (v) => (v == null || v === "" ? "—" : "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const num = (v, d = 1) => (v == null ? "—" : Number(v).toFixed(d));
const pct = (v, d = 1) => (v == null ? "—" : (v > 0 ? "+" : "") + Number(v).toFixed(d) + "%");
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const ACTION_COLOR = { buy: "var(--green)", watch: "var(--teal)", wait: "var(--yellow)", avoid: "var(--red)" };
const VERDICT_COLOR = { BUY: "var(--green)", NEUTRAL: "var(--yellow)", AVOID: "var(--red)", WAIT: "var(--yellow)" };
function convColor(s) { return s >= 7 ? "var(--green)" : s >= 5.5 ? "var(--teal)" : s >= 4 ? "var(--yellow)" : "var(--red)"; }

// ---------- auth ----------
async function init() {
  const { data: { session } } = await sb.auth.getSession();
  showAuth(session);
  sb.auth.onAuthStateChange((_e, s) => showAuth(s));
  buildAnalyzerFields();
  $("tax-year").addEventListener("change", renderTax);
  $("tax-csv").addEventListener("click", taxCSV);
  $("tax-print").addEventListener("click", () => window.print());
  $("al-type").addEventListener("change", alertRuleUI);
  $("al-add").addEventListener("click", addAlert);
}
function showAuth(session) {
  const authed = !!session;
  $("login").classList.toggle("hidden", authed);
  $("app").classList.toggle("hidden", !authed);
  $("hdr-right").textContent = authed ? (session.user.email || "") : "";
  if (authed) loadAll();
}
$("send-link").addEventListener("click", async () => {
  const email = $("email").value.trim();
  const msg = $("login-msg");
  if (!email) { msg.innerHTML = '<span class="err">Enter your email.</span>'; return; }
  $("send-link").disabled = true; msg.textContent = "Sending…";
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: location.origin + location.pathname } });
  $("send-link").disabled = false;
  msg.innerHTML = error ? `<span class="err">${esc(error.message)}</span>` : '<span class="ok">Check your email and click the login link.</span>';
});
$("logout").addEventListener("click", () => sb.auth.signOut());

// ---------- toast ----------
let TOAST_TIMER = null;
function showToast(msg, kind = "ok") {
  const t = $("toast");
  t.textContent = msg;
  t.classList.toggle("warn", kind === "warn");
  t.classList.add("show");
  if (TOAST_TIMER) clearTimeout(TOAST_TIMER);
  TOAST_TIMER = setTimeout(() => t.classList.remove("show"), 2800);
}

// ---------- tabs ----------
const TABS = ["candidates", "bitcoin", "analyzer", "frameworks", "social", "trades", "portfolio", "tax", "scorecard", "alerts", "settings"];
function activateTab(name) {
  document.querySelectorAll(".tab").forEach((x) => x.classList.toggle("active", x.dataset.tab === name));
  TABS.forEach((v) => $("view-" + v).classList.toggle("hidden", v !== name));
  const map = { frameworks: renderFrameworks, social: loadSocial, trades: loadTrades, portfolio: loadPortfolio, tax: loadTax, scorecard: loadScorecard, alerts: loadAlerts, settings: loadSettings };
  if (map[name]) map[name]();
  window.scrollTo(0, 0);
}
document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => activateTab(t.dataset.tab)));
$("refresh").addEventListener("click", loadAll);

// ---------- shared data ----------
async function latestScan() {
  const { data, error } = await sb.from("scans").select("id,scan_timestamp,universe_slice")
    .eq("status", "complete").order("scan_timestamp", { ascending: false }).limit(1);
  if (error) throw error;
  return data && data[0];
}
async function findOrCreateAsset(symbol) {
  symbol = symbol.toUpperCase().trim();
  const { data } = await sb.from("assets").select("id").eq("symbol", symbol).eq("asset_type", "stock").limit(1);
  if (data && data[0]) return data[0].id;
  const { data: ins, error } = await sb.from("assets").insert({ symbol, asset_type: "stock" }).select("id");
  if (error) throw error;
  return ins[0].id;
}

async function loadAll() {
  try {
    const scan = await latestScan();
    await Promise.all([loadCandidates(scan), loadBitcoin(scan)]);
  } catch (e) { $("cand-list").innerHTML = `<div class="card err">Error: ${esc(e.message)}</div>`; }
}

// ---------- Candidates ----------
async function loadCandidates(scan) {
  const meta = $("cand-meta"), list = $("cand-list");
  if (!scan) { meta.textContent = "No scans yet"; list.innerHTML = '<div class="card muted">Run a scan to see candidates.</div>'; return; }
  meta.textContent = `Latest scan · ${new Date(scan.scan_timestamp).toLocaleString()} · ${scan.universe_slice}`;
  const { data, error } = await sb.from("recommendations")
    .select("conviction,action,entry_target,stop_loss,exit_target,position_size_pct,rationale,assets(symbol,name,sector)")
    .eq("scan_id", scan.id).order("conviction", { ascending: false });
  if (error) { list.innerHTML = `<div class="card err">${esc(error.message)}</div>`; return; }
  if (!data.length) { list.innerHTML = '<div class="card muted">No recommendations in the latest scan.</div>'; return; }
  list.innerHTML = data.map((r, i) => {
    const a = r.assets || {}, c = Number(r.conviction);
    const band = c >= 7 ? "Strong" : c >= 5.5 ? "Moderate" : "Weak";
    const oneLiner = {
      buy: "Strong buy — most of the 7 strategies agree. Consider entering near the suggested price.",
      watch: "Lean buy — promising but not unanimous. Consider a smaller position or waiting for a dip.",
      wait: "Mixed — no clear edge yet. Worth watching rather than buying now.",
      avoid: "Avoid — the strategies lean negative. Better to pass for now.",
    }[r.action] || "";
    const entry = Number(r.entry_target) || 0;
    const stopPct = entry && r.stop_loss ? Math.round((1 - r.stop_loss / entry) * 100) : 8;
    const t1 = entry * 1.12, t2 = entry * 1.20, t3 = entry * 1.40;
    return `<div class="card">
      <div class="row between">
        <div class="row" style="gap:12px;"><span class="dim" style="width:18px;">${i + 1}</span>
          <div><span class="tk">${esc(a.symbol)}</span><div class="nm">${esc(a.name)}${a.sector ? " · " + esc(a.sector) : ""}</div></div></div>
        <div class="center"><div class="big" style="color:${convColor(c)}">${c.toFixed(1)}<span class="dim" style="font-size:14px;"> / 10</span></div>
          <span class="pill" style="background:rgba(255,255,255,.06); color:${ACTION_COLOR[r.action] || "var(--muted)"}">${esc((r.action || "").toUpperCase())}</span></div></div>
      <div class="fieldtip" style="margin-top:6px;"><b style="color:${convColor(c)}">${band} conviction</b> (${c.toFixed(1)}/10 — how strongly the 7 strategies agree; 7+ is strong). ${oneLiner}</div>
      <div class="grid3" style="margin-top:12px;">
        <div class="stat"><div class="k">Suggested buy</div><div class="v">${money(r.entry_target)}</div></div>
        <div class="stat"><div class="k">Stop-loss</div><div class="v" style="color:var(--red)">${money(r.stop_loss)}</div></div>
        <div class="stat"><div class="k">Suggested size</div><div class="v">${num(r.position_size_pct, 1)}%</div></div></div>
      <div class="fieldtip">Buy ≈ the price at scan time — aim to enter near here. Stop-loss = sell if it falls to this (−${stopPct}%) to cap your loss. Size = suggested share of your <b>total portfolio</b>.</div>
      <div class="fieldtip" style="margin-top:10px;">Profit targets (rule-of-thumb, from the buy price):</div>
      <div class="grid3" style="margin-top:4px;">
        <div class="stat"><div class="k">Short-term</div><div class="v" style="color:var(--green)">${money(t1)} <span class="dim" style="font-size:12px;">+12%</span></div></div>
        <div class="stat"><div class="k">Mid-term</div><div class="v" style="color:var(--green)">${money(t2)} <span class="dim" style="font-size:12px;">+20%</span></div></div>
        <div class="stat"><div class="k">Long-term</div><div class="v" style="color:var(--green)">${money(t3)} <span class="dim" style="font-size:12px;">+40%</span></div></div></div>
    </div>`;
  }).join("");
}

// ---------- Bitcoin ----------
async function loadBitcoin(scan) {
  const box = $("btc"); let snap = null;
  if (scan) { const { data } = await sb.from("bitcoin_snapshots").select("*").eq("scan_id", scan.id).limit(1); snap = data && data[0]; }
  if (!snap) { const { data } = await sb.from("bitcoin_snapshots").select("*").order("created_at", { ascending: false }).limit(1); snap = data && data[0]; }
  if (!snap) { box.innerHTML = '<div class="card muted">No Bitcoin snapshot yet.</div>'; return; }
  const BTC_COMP = {
    trend: "Is the price above its key moving averages? Above = uptrend (bullish), below = downtrend.",
    cycle: "Where Bitcoin sits in its ~4-year halving cycle. Mid-cycle is historically bullish; late-cycle = caution.",
    sentiment: "The crowd's mood (Fear & Greed). Extreme fear can be a contrarian buying chance; extreme greed = caution.",
    rsi: "Momentum, 0–100. Under 30 = oversold (possible bounce); over 70 = overbought (possible pullback).",
    seasonality: "How Bitcoin has tended to perform in this calendar month, historically.",
  };
  const fng = Number(snap.fear_greed);
  const fngText = isNaN(fng) ? "" : fng <= 25 ? "Extreme fear — historically a contrarian buy zone"
    : fng <= 45 ? "Fear" : fng <= 55 ? "Neutral" : fng <= 75 ? "Greed" : "Extreme greed — caution";
  const cs = Number(snap.composite_score);
  const comp = (snap.raw && snap.raw.components) || {};
  const compRows = Object.entries(comp).map(([k, v]) => {
    const s = Number(v.score || 0);
    return `<div style="margin-bottom:12px;"><div class="row between" style="font-size:14px;">
      <span style="text-transform:capitalize; font-weight:600;">${esc(k)}</span><span class="muted">${num(s, 1)}/10 · ${esc(v.note)}</span></div>
      <div class="bar"><div class="fill" style="width:${(s / 10) * 100}%; background:${convColor(s)}"></div></div>
      <div class="fieldtip">${esc(BTC_COMP[k] || "")}</div></div>`;
  }).join("");
  box.innerHTML = `
    <div class="card"><div class="row between">
      <div><div class="dim" style="font-size:12px;">BITCOIN PRICE</div><div class="big">${money(snap.price)}</div></div>
      <div class="center"><div class="dim" style="font-size:12px;">VERDICT</div>
        <div class="big" style="color:${convColor(cs)}">${esc(snap.verdict)}</div></div></div>
      <div class="fieldtip" style="margin-top:8px;"><b>${esc(snap.position_guidance)}</b></div>
      <div class="fieldtip">Overall score <b style="color:${convColor(cs)}">${num(cs, 1)}/10</b> — higher = more favourable. The verdict turns trend, cycle, sentiment, RSI and seasonality into one action.</div></div>
    <div class="card"><div class="grid4">
      <div class="stat"><div class="k">RSI 14</div><div class="v">${num(snap.rsi_14, 0)}</div></div>
      <div class="stat"><div class="k">Fear / Greed</div><div class="v">${num(snap.fear_greed, 0)} / 100</div></div>
      <div class="stat"><div class="k">vs all-time high</div><div class="v">${pct(snap.ath_change_pct)}</div></div>
      <div class="stat"><div class="k">50d / 200d avg</div><div class="v" style="font-size:14px;">${money(snap.ma_50)} / ${money(snap.ma_200)}</div></div></div>
      <div class="fieldtip" style="margin-top:10px;"><b>Fear &amp; Greed ${num(snap.fear_greed, 0)}/100 — ${fngText}.</b> The index runs 0 (extreme fear) to 100 (extreme greed). Low readings often mark bargains, high readings mark froth.</div>
      <div class="fieldtip"><b>RSI</b> 0–100 momentum (under 30 oversold, over 70 overbought). <b>vs all-time high</b>: how far below the peak — a big discount can mean opportunity or weakness. <b>50d/200d average</b>: price above these = uptrend.</div>
      <div class="fieldtip" style="margin-top:8px;">${esc(snap.cycle_phase)}</div></div>
    ${compRows ? `<div class="card"><div class="dim" style="font-size:12px; margin-bottom:4px;">SIGNAL BREAKDOWN</div>
      <div class="fieldtip" style="margin-bottom:12px;">Each driver scored 0–10 (higher = more bullish for Bitcoin):</div>${compRows}</div>` : ""}`;
}

// ====================================================================
// SOCIAL (Camillo Google-Trends + Reddit, and Grok/X relay)
// ====================================================================
const FLAG_DESC = {
  "SEARCH BREAKOUT": "Google searches are spiking",
  "HIGH REDDIT CHATTER": "unusually high Reddit posting",
  "CONVERGING SIGNAL": "search AND social rising together — the strongest read",
  "UNUSUAL X ACTIVITY": "abnormal activity on X (Twitter)",
  "BULLISH ACCELERATION": "bullish chatter speeding up",
  "VIRAL VOLUME": "viral-level post volume",
};
async function loadSocial() {
  const list = $("social-list");
  const scan = await latestScan();
  if (!scan) { list.innerHTML = '<div class="card muted">No scans yet.</div>'; return; }
  const { data, error } = await sb.from("social_signals")
    .select("source,social_score,momentum_pct,volume_metric,sentiment,flags,catalyst,assets(symbol,name)")
    .eq("scan_id", scan.id);
  if (error) { list.innerHTML = `<div class="card err">${esc(error.message)}</div>`; return; }
  if (!data.length) { list.innerHTML = '<div class="card muted">No social signals in the latest scan.</div>'; return; }

  // group rows per ticker
  const byTicker = {};
  data.forEach((r) => {
    const sym = (r.assets || {}).symbol || "?";
    const g = byTicker[sym] || (byTicker[sym] = { sym, name: (r.assets || {}).name, trends: null, reddit: null, grok: null });
    if (r.source === "trends") g.trends = r;
    else if (r.source === "reddit") g.reddit = r;
    else if (r.source === "grok_x") g.grok = r;
  });
  const score = (g) => Number((g.trends && g.trends.social_score) ?? (g.grok && g.grok.social_score) ?? (g.reddit && g.reddit.social_score) ?? 0);
  const groups = Object.values(byTicker).sort((a, b) => score(b) - score(a));

  list.innerHTML = groups.map((g) => {
    const s = score(g);
    const flags = (g.trends && g.trends.flags && g.trends.flags.flags) || (g.grok && g.grok.flags && g.grok.flags.flags) || [];
    const mom = g.trends ? g.trends.momentum_pct : null;
    const posts = g.reddit ? g.reddit.volume_metric : null;
    const flagPills = flags.map((f) => `<span class="pill" style="background:rgba(0,255,135,.10); color:var(--green); margin-right:6px;">${esc(f)}</span>`).join("");
    const flagExpl = flags.length ? `<div class="fieldtip">${flags.map((f) => esc(f) + " = " + esc(FLAG_DESC[f] || "")).join("; ")}.</div>` : "";
    const grok = g.grok ? `<div class="fieldtip" style="margin-top:8px;"><b>X (Twitter):</b> ${esc(g.grok.sentiment || "n/a")} sentiment, score ${num(g.grok.social_score, 1)}/10${g.grok.catalyst && g.grok.catalyst !== "none" ? " — catalyst: " + esc(g.grok.catalyst) : ""}.</div>` : "";
    return `<div class="card">
      <div class="row between">
        <div><span class="tk">${esc(g.sym)}</span> <span class="nm">${esc(g.name || "")}</span></div>
        <div class="center"><div class="big" style="color:${convColor(s)}">${s.toFixed(1)}<span class="dim" style="font-size:13px;"> / 10</span></div></div></div>
      <div class="bar" style="margin-top:8px;"><div class="fill" style="width:${(s / 10) * 100}%; background:${convColor(s)}"></div></div>
      <div class="fieldtip" style="margin-top:6px;">Social score 0–10 — how unusual the public attention is right now. Higher = a stronger "something's happening" signal.</div>
      <div class="grid2" style="margin-top:10px;">
        <div class="stat"><div class="k">Search momentum</div><div class="v" style="color:${mom > 0 ? "var(--green)" : "var(--muted)"}">${mom == null ? "—" : pct(mom, 0)}</div></div>
        <div class="stat"><div class="k">Reddit posts / week</div><div class="v">${posts == null ? "—" : num(posts, 0)}</div></div></div>
      <div class="fieldtip"><b>Search momentum</b>: change in Google search interest vs prior weeks — big jumps can precede real demand. <b>Reddit posts/week</b>: how much people are posting about it.</div>
      ${flagPills ? `<div style="margin-top:10px;">${flagPills}</div>${flagExpl}` : ""}
      ${grok}
    </div>`;
  }).join("");
}

// ====================================================================
// ANALYZER — plain-English verdict + trade plan + metric tooltips
// ====================================================================
const METRICS = [
  { id: "in-rev", key: "rev", label: "Revenue growth % (YoY)", val: 10, step: "any",
    tip: "How fast sales are growing vs a year ago. Higher is better; negative means the business is shrinking." },
  { id: "in-eps", key: "eps", label: "Earnings growth % (YoY)", val: 15, step: "any",
    tip: "How fast profits are growing vs a year ago. Higher is better; 20–50% is strong growth; below 0 means profits are falling." },
  { id: "in-margin", key: "margin", label: "Gross margin %", val: 45, step: "any",
    tip: "Profit kept from each dollar of sales before overhead. Higher = stronger pricing power. Over 40% is strong, under 20% is thin." },
  { id: "in-fcf", key: "fcf", label: "Free cash flow yield %", val: 4, step: "any",
    tip: "Spare cash the company generates compared with its price. Higher = better value. Above 4% is healthy, under 1% is weak." },
  { id: "in-rel", key: "rel", label: "Relative strength % (12m)", val: 20, step: "any",
    tip: "Price change over the last year. Positive = uptrend; strongly positive (>30%) = a market leader; very negative = a laggard." },
  { id: "in-rsi", key: "rsi", label: "RSI (14)", val: 55, step: "any",
    tip: "Momentum gauge from 0–100. Below 30 = oversold (possibly cheap), above 70 = overbought (possibly stretched), ~50 is neutral." },
  { id: "in-de", key: "de", label: "Debt / equity (ratio)", val: 0.5, step: "0.1",
    tip: "How much debt the company carries vs shareholder money. Lower = safer. Under 0.5 is conservative; over 2 is risky." },
  { id: "in-ma", key: "ma", label: "Price vs long-term avg %", val: 8, step: "any",
    tip: "How far the price sits above (or below) its 200-day average. Positive = uptrend, negative = downtrend." },
];

function buildAnalyzerFields() {
  $("an-fields").innerHTML = METRICS.map((m) => `
    <div>
      <label class="fld">${m.label}</label>
      <input id="${m.id}" type="number" step="${m.step}" value="${m.val}" />
      <div class="fieldtip">${esc(m.tip)}</div>
    </div>`).join("");
}

$("an-load").addEventListener("click", async () => {
  const sym = $("an-ticker").value.toUpperCase().trim();
  const msg = $("an-load-msg");
  if (!sym) { msg.innerHTML = '<span class="err">Type a ticker first.</span>'; return; }
  msg.textContent = "Loading latest scan data…";
  // most recent market_data row for this symbol
  const { data, error } = await sb.from("market_data")
    .select("price,rsi_14,ma_200,rel_strength_12m,revenue_growth,earnings_growth,gross_margin,fcf_yield,debt_to_equity,captured_at,assets!inner(symbol)")
    .eq("assets.symbol", sym).order("captured_at", { ascending: false }).limit(1);
  if (error) { msg.innerHTML = `<span class="err">${esc(error.message)}</span>`; return; }
  if (!data || !data.length) { msg.innerHTML = `<span class="err">No scan data for ${esc(sym)} yet. Enter the numbers by hand, or scan it first.</span>`; return; }
  const m = data[0];
  $("an-price").value = m.price ?? "";
  const setv = (id, v) => { if (v != null) $(id).value = v; };
  setv("in-rev", (m.revenue_growth ?? 0) * 100);
  setv("in-eps", (m.earnings_growth ?? 0) * 100);
  setv("in-margin", (m.gross_margin ?? 0) * 100);
  setv("in-fcf", (m.fcf_yield ?? 0) * 100);
  setv("in-rel", (m.rel_strength_12m ?? 0) * 100);
  setv("in-rsi", m.rsi_14 ?? 50);
  setv("in-de", m.debt_to_equity ?? 0);
  if (m.price && m.ma_200) setv("in-ma", ((m.price - m.ma_200) / m.ma_200) * 100);
  msg.innerHTML = `<span class="ok">Loaded ${esc(sym)} from ${new Date(m.captured_at).toLocaleDateString()}.</span>`;
});

// ---- 7-framework scoring (verbatim port of engine/gates/gate3 + IIP_Command_Center.html) ----
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function verdictFor(s) { return s >= 7 ? "BUY" : s >= 5 ? "NEUTRAL" : "AVOID"; }
function frameworks(d) {
  const out = [];
  let gs = 5; if (d.fcf > 5) gs += 2; else if (d.fcf > 2) gs += 1; else gs -= 1;
  if (d.de < 0.5) gs += 1; else if (d.de > 2) gs -= 2; if (d.eps > 10) gs += 1; else if (d.eps < 0) gs -= 2;
  out.push(["Graham", "Deep value", clamp(gs, 1, 10), "value"]);
  let bs = 5; if (d.margin > 50) bs += 2; else if (d.margin > 35) bs += 1; else if (d.margin < 20) bs -= 1;
  if (d.eps > 10 && d.eps < 50) bs += 1; if (d.de < 0.5) bs += 1; else if (d.de > 1.5) bs -= 1; if (d.fcf > 4) bs += 1; else if (d.fcf < 1) bs -= 1;
  out.push(["Buffett", "Quality compounder", clamp(bs, 1, 10), "long"]);
  let ls = 5; if (d.eps >= 20 && d.eps <= 50) ls += 3; else if (d.eps > 50 && d.eps <= 100) ls += 2; else if (d.eps > 100) ls += 1; else if (d.eps > 10) ls += 1; else if (d.eps < 0) ls -= 2;
  if (d.rev > 10) ls += 1; else if (d.rev < 0) ls -= 1; if (d.rsi > 75) ls -= 1; else if (d.rsi < 35) ls += 1; if (d.rel > 30) ls += 1; else if (d.rel < -20) ls -= 1;
  out.push(["Lynch", "Growth at reasonable price", clamp(ls, 1, 10), "mid"]);
  let ms = 5; if (d.fcf > 6) ms += 2; else if (d.fcf > 3) ms += 1; else if (d.fcf < 1) ms -= 2;
  let roic = d.margin / (1 + d.de) / 100; if (roic > 0.30) ms += 2; else if (roic > 0.15) ms += 1; else if (roic < 0.05) ms -= 1; if (d.eps > 15) ms += 1;
  out.push(["Magic Formula", "Earnings yield × ROIC", clamp(ms, 1, 10), "mid"]);
  let mo = 5; if (d.rel > 50) mo += 3; else if (d.rel > 20) mo += 2; else if (d.rel > 0) mo += 1; else mo -= 2;
  if (d.ma > 10) mo += 1; else if (d.ma > 0) mo += 0.5; else mo -= 1; if (d.rsi > 80) mo -= 1; else if (d.rsi >= 45 && d.rsi <= 65) mo += 1;
  out.push(["Momentum", "Trend persistence", clamp(mo, 1, 10), "short"]);
  let cs = 5; if (d.eps > 15 && d.rel < -10) cs += 3; else if (d.eps > 10 && d.rsi < 40) cs += 2; else if (d.rsi > 75 && d.rel > 50) cs -= 2; else if (d.rsi > 70 && d.eps < 10) cs -= 1;
  out.push(["Marks", "Contrarian / 2nd level", clamp(cs, 1, 10), "mid"]);
  let ts = 5; if (d.de < 0.3) ts += 2; else if (d.de < 0.7) ts += 1; else if (d.de > 1.5) ts -= 2; else if (d.de > 2.5) ts -= 3;
  if (d.margin > 50) ts += 1; else if (d.margin < 20) ts -= 1; if (d.fcf > 4) ts += 1; else if (d.fcf < 1) ts -= 1; if (d.rel > 100) ts -= 1;
  out.push(["Taleb", "Antifragility / risk", clamp(ts, 1, 10), "long"]);
  return out;
}
function convergence(fws) {
  let buys = 0, avoids = 0, sum = 0; const n = fws.length;
  fws.forEach((f) => { const v = verdictFor(f[2]); if (v === "BUY") buys++; if (v === "AVOID") avoids++; sum += f[2]; });
  const avg = sum / n, ratio = (buys - avoids) / n;
  let signal;
  if (ratio >= 0.5) signal = "strong"; else if (ratio >= 0.3) signal = "lean";
  else if (ratio <= -0.3) signal = "avoid"; else if (avoids >= 3) signal = "redflag"; else signal = "mixed";
  return { avg, ratio, buys, avoids, neutrals: n - buys - avoids, signal };
}

// ---- plain-English synthesis ----
const HORIZON_W = { short: 1, mid: 2, long: 3 };
function tradeHorizon(fws) {
  let wsum = 0, sw = 0;
  fws.forEach((f) => { const w = f[2]; wsum += w * HORIZON_W[f[3]]; sw += w; });
  const h = sw ? wsum / sw : 2;
  if (h < 1.8) return { label: "Short-term (weeks to a few months)", stop: 0.06, target: 0.12 };
  if (h < 2.4) return { label: "Mid-term (3–9 months)", stop: 0.08, target: 0.20 };
  return { label: "Long-term (1+ years)", stop: 0.12, target: 0.40 };
}
function plainSignals(d) {
  const pos = [], neg = [];
  if (d.rel > 30) pos.push("it has been a market leader over the past year");
  else if (d.rel < -20) neg.push("it has badly lagged the market this past year");
  if (d.eps > 20) pos.push("profits are growing strongly");
  else if (d.eps < 0) neg.push("profits are shrinking");
  if (d.rev > 15) pos.push("sales are growing fast");
  else if (d.rev < 0) neg.push("sales are declining");
  if (d.margin > 50) pos.push("it has excellent profit margins");
  else if (d.margin < 20) neg.push("its profit margins are thin");
  if (d.fcf > 5) pos.push("it throws off strong free cash flow");
  else if (d.fcf < 1) neg.push("it generates little spare cash");
  if (d.de < 0.5) pos.push("it has a strong, low-debt balance sheet");
  else if (d.de > 2) neg.push("it carries heavy debt");
  if (d.rsi > 75) neg.push("it looks overbought right now (a pullback is possible)");
  else if (d.rsi < 30) pos.push("it looks oversold (potentially a bargain entry)");
  if (d.ma > 10) pos.push("it trades well above its long-term trend");
  else if (d.ma < 0) neg.push("it trades below its long-term trend");
  return { pos, neg };
}
function joinList(arr) {
  if (!arr.length) return "";
  if (arr.length === 1) return arr[0];
  return arr.slice(0, -1).join(", ") + " and " + arr[arr.length - 1];
}

$("run-analyzer").addEventListener("click", () => {
  const g = (id) => parseFloat($(id).value) || 0;
  const d = { rev: g("in-rev"), eps: g("in-eps"), margin: g("in-margin"), fcf: g("in-fcf"),
              rel: g("in-rel"), rsi: g("in-rsi") || 50, de: g("in-de"), ma: g("in-ma") };
  const price = parseFloat($("an-price").value) || 0;
  const ticker = $("an-ticker").value.toUpperCase().trim();
  const fws = frameworks(d);
  const conv = convergence(fws);
  const hz = tradeHorizon(fws);
  const sig = conv.signal;

  // headline verdict
  let verdict, vcolor, lede;
  if (sig === "strong") { verdict = "BUY"; vcolor = "var(--green)"; lede = "Strong agreement across the strategies."; }
  else if (sig === "lean") { verdict = "BUY"; vcolor = "var(--teal)"; lede = "A lean buy — more in favour than against, but not unanimous."; }
  else if (sig === "avoid") { verdict = "AVOID"; vcolor = "var(--red)"; lede = "The strategies disagree or lean negative."; }
  else if (sig === "redflag") { verdict = "AVOID"; vcolor = "var(--red)"; lede = "Several red flags here."; }
  else { verdict = "WAIT"; vcolor = "var(--yellow)"; lede = "Mixed signals — no clear edge yet."; }

  const { pos, neg } = plainSignals(d);
  const name = ticker || "This stock";

  // trade plan (needs a price for dollar levels)
  let plan = "";
  if (price > 0) {
    const lo = price * 0.97, hi = price * 1.01;
    const stop = price * (1 - hz.stop), target = price * (1 + hz.target);
    const rr = (target - price) / (price - stop);
    plan = `
      <div class="grid4" style="margin-top:6px;">
        <div class="stat"><div class="k">Entry range</div><div class="v">${money(lo)}–${money(hi)}</div></div>
        <div class="stat"><div class="k">Stop-loss</div><div class="v" style="color:var(--red)">${money(stop)} (−${Math.round(hz.stop*100)}%)</div></div>
        <div class="stat"><div class="k">Target</div><div class="v" style="color:var(--green)">${money(target)} (+${Math.round(hz.target*100)}%)</div></div>
        <div class="stat"><div class="k">Reward:risk</div><div class="v">${rr.toFixed(1)} : 1</div></div>
      </div>`;
  } else {
    plan = `<div class="muted" style="margin-top:8px;">Enter a current price above to get exact entry / stop / target levels.</div>`;
  }

  // plain-English recommendation paragraph
  let para;
  if (verdict === "BUY") {
    para = `${name} rates a <b>BUY</b>. ${conv.buys} of 7 strategies are positive (only ${conv.avoids} negative). `
      + (pos.length ? `The case for it: ${joinList(pos)}. ` : "")
      + (neg.length ? `Keep an eye on the downside: ${joinList(neg)}. ` : "")
      + `If you take it, buy near the entry range, set the stop-loss to cap your loss, and aim for the target. This profiles as a <b>${hz.label.toLowerCase()}</b> trade.`;
  } else if (verdict === "WAIT") {
    para = `${name} is a <b>WAIT</b>. The strategies are split (${conv.buys} for, ${conv.avoids} against), so there's no clear edge. `
      + (pos.length ? `On the plus side: ${joinList(pos)}. ` : "")
      + (neg.length ? `Against it: ${joinList(neg)}. ` : "")
      + `Better to watch it and revisit if the picture sharpens — for example a dip toward your entry range or a stronger earnings trend.`;
  } else {
    para = `${name} rates an <b>AVOID</b> for now. ${conv.avoids} of 7 strategies are negative. `
      + (neg.length ? `The concerns: ${joinList(neg)}. ` : "")
      + (pos.length ? `It's not all bad — ${joinList(pos)} — but that isn't enough to outweigh the risks today. ` : "")
      + `Wait for the fundamentals or trend to improve before considering it.`;
  }

  const rows = fws.map((f) => {
    const v = verdictFor(f[2]);
    return `<div class="card" style="padding:11px 14px; margin-bottom:8px;"><div class="row between">
      <div><div class="tk" style="font-size:16px;">${f[0]}</div><div class="nm">${f[1]}</div></div>
      <div class="row" style="gap:14px;">
        <span class="pill" style="background:rgba(255,255,255,.06); color:${VERDICT_COLOR[v]}">${v}</span>
        <span class="big" style="color:${convColor(f[2])}">${f[2].toFixed(1)}</span></div></div></div>`;
  }).join("");

  $("analyzer-result").innerHTML = `
    <div class="verdict-box" style="background:${vcolor === "var(--yellow)" ? "rgba(255,217,61,.08)" : vcolor === "var(--red)" ? "rgba(255,93,93,.08)" : "rgba(0,255,135,.08)"}; border-color:${vcolor};">
      <div class="row between"><div class="xl" style="color:${vcolor}">${verdict}</div>
        <div class="center"><div class="dim" style="font-size:12px;">AVG SCORE</div><div class="big">${conv.avg.toFixed(2)}/10</div></div></div>
      <div class="muted" style="margin-top:4px;">${lede}</div>
      ${plan}
    </div>
    <div class="card"><div class="plan-line">${para}</div></div>
    <div class="dim" style="font-size:12px; margin:14px 2px 8px;">HOW EACH STRATEGY VOTED</div>
    ${rows}`;
  $("analyzer-result").classList.remove("hidden");
});

// ====================================================================
// FRAMEWORKS — static, plain-English reference for the 7 scoring lenses.
// Live per-candidate scores wire in later. Copy is owner-supplied and kept verbatim.
// ====================================================================
const FW_FAMILIES = [
  { key: "value",  name: "Value",  color: "var(--blue)",   tag: "buying cheap" },
  { key: "growth", name: "Growth", color: "var(--teal)",   tag: "buying expansion" },
  { key: "quant",  name: "Quant",  color: "var(--yellow)", tag: "following the trend" },
  { key: "risk",   name: "Risk",   color: "var(--red)",    tag: "veto layer — can block a buy" },
];
const FRAMEWORKS_INFO = [
  {
    key: "graham", name: "Graham", family: "value",
    lead: "The bargain hunter. Looks for stocks trading below what the company is actually worth, so you're buying a dollar for 70 cents. High score = cheap relative to its real value.",
    whatIs: "The bargain hunter. Looks for stocks trading below what the company is actually worth, so you're buying a dollar for 70 cents.",
    whoFrom: "Benjamin Graham — the father of value investing and Warren Buffett's teacher; he bought companies for less than their parts were worth.",
    looksAt: ["The price versus the company's real, underlying worth", "A strong, low-debt balance sheet", "How little you're paying for each dollar of earnings"],
    howToRead: "High score = cheap relative to its real value. Low score = expensive, so less margin of safety.",
  },
  {
    key: "buffett", name: "Buffett", family: "value",
    lead: "The quality buyer. Looks for strong, durable companies with a real edge over competitors. High score = a great business, not just a cheap one.",
    whatIs: "The quality buyer. Looks for strong, durable companies with a real edge over competitors.",
    whoFrom: "Warren Buffett — buys wonderful businesses he can hold for years, and lets them compound.",
    looksAt: ["A durable competitive edge (a \"moat\")", "High, steady profit margins", "Plenty of spare cash thrown off by the business"],
    howToRead: "High score = a great business, not just a cheap one. Low score = an ordinary business without a clear edge.",
  },
  {
    key: "magic", name: "Magic Formula", family: "value",
    lead: "A simple two-part test: is the company cheap, AND does it earn good returns on its money? High score = both at once — good company at a fair price.",
    whatIs: "A simple two-part test: is the company cheap, AND does it earn good returns on its money?",
    whoFrom: "Joel Greenblatt — ranked companies on cheapness and quality together, and bought the best of both.",
    looksAt: ["Is it cheap (earnings yield)?", "Does it earn high returns on the capital it uses?", "Both ranked together, not one in isolation"],
    howToRead: "High score = both at once — good company at a fair price. Low score = either pricey or low-quality (or both).",
  },
  {
    key: "lynch", name: "Lynch", family: "growth",
    lead: "Buys growth without overpaying. Likes companies growing fast but still reasonably priced. High score = growing quickly without being expensive.",
    whatIs: "Buys growth without overpaying. Likes companies growing fast but still reasonably priced.",
    whoFrom: "Peter Lynch — looked for fast growers the market hadn't fully priced in yet.",
    looksAt: ["Fast earnings growth", "A price that's still reasonable for that growth", "Not already over-hyped"],
    howToRead: "High score = growing quickly without being expensive. Low score = either slow-growing or priced for perfection.",
  },
  {
    key: "momentum", name: "Momentum", family: "quant",
    lead: "Follows the trend. Stocks going up tend to keep going up for a while. High score = strong recent price strength and direction.",
    whatIs: "Follows the trend. Stocks going up tend to keep going up for a while.",
    whoFrom: "Cliff Asness / AQR — showed systematically that recent winners tend to keep winning for a while.",
    looksAt: ["Strong recent price performance", "Trading above its long-term trend line", "Steady direction rather than wild swings"],
    howToRead: "High score = strong recent price strength and direction. Low score = weak, falling, or directionless.",
  },
  {
    key: "marks", name: "Marks", family: "risk",
    lead: "The cycle reader. Asks where we are in the market cycle and whether risk is being rewarded or ignored. High score = good risk/reward for where the market is right now.",
    whatIs: "The cycle reader. Asks where we are in the market cycle and whether risk is being rewarded or ignored.",
    whoFrom: "Howard Marks — famous for reading market cycles and buying when others are fearful.",
    looksAt: ["Where we are in the market cycle", "Whether you're being paid to take the risk", "Crowd fear versus greed"],
    howToRead: "High score = good risk/reward for where the market is right now. Low score = you're taking risk that isn't being rewarded.",
  },
  {
    key: "taleb", name: "Taleb", family: "risk",
    lead: "The survivor. Focuses on what could blow up and avoiding catastrophic loss. This one can veto a buy even if every other score is high. High score = limited downside / safe from a crash.",
    whatIs: "The survivor. Focuses on what could blow up and avoiding catastrophic loss. This one can veto a buy even if every other score is high.",
    whoFrom: "Nassim Taleb — obsessed with surviving rare, catastrophic shocks rather than chasing the last dollar of gain.",
    looksAt: ["How much could go wrong in a worst case", "Low debt and the ability to survive shocks", "Avoiding bets that can wipe you out"],
    howToRead: "High score = limited downside / safe from a crash. Low score = fragile, with the risk of a catastrophic loss — and it can override the other six.",
  },
];
const FW_BY_KEY = Object.fromEntries(FRAMEWORKS_INFO.map((f) => [f.key, f]));

function renderFrameworks() {
  const list = $("fw-list");
  if (list.dataset.built) return;   // static content — build once
  const famColor = Object.fromEntries(FW_FAMILIES.map((f) => [f.key, f.color]));
  let html = "";
  FW_FAMILIES.forEach((fam) => {
    const members = FRAMEWORKS_INFO.filter((f) => f.family === fam.key);
    html += `<div class="fam-head">
        <span class="fam-dot" style="background:${fam.color}"></span>
        <span class="fam-name" style="color:${fam.color}">${esc(fam.name)}</span>
        <span class="fam-tag">${esc(fam.tag)}</span></div>`;
    html += members.map((f) => `<div class="fwcard" data-fw="${f.key}" style="border-left-color:${fam.color}">
        <div class="row between">
          <div><span class="tk" style="font-size:17px;">${esc(f.name)}</span>
            <div class="nm" style="margin-top:3px; line-height:1.4;">${esc(f.whatIs)}</div></div>
          <span class="arrow">›</span></div></div>`).join("");
  });
  html += `<div class="composite">
      <div class="row between"><div class="tk" style="font-size:17px; color:var(--purple)">Composite Score</div>
        <span class="linkpill">all 7 combined</span></div>
      <div class="fieldtip" style="margin-top:8px; font-size:14px; color:var(--muted)">Agreement across families = high conviction. Disagreement = the signal worth reading.</div></div>`;
  list.innerHTML = html;
  list.dataset.built = "1";
  list.querySelectorAll("[data-fw]").forEach((c) => c.addEventListener("click", () => openFwPanel(c.dataset.fw)));
}

function openFwPanel(key) {
  const f = FW_BY_KEY[key];
  if (!f) return;
  const fam = FW_FAMILIES.find((x) => x.key === f.family) || {};
  const panel = $("fw-panel"), backdrop = $("fw-backdrop");
  panel.innerHTML = `
    <button class="fw-close" aria-label="Close" id="fw-close">×</button>
    <div class="pill" style="background:rgba(255,255,255,.06); color:${fam.color}; display:inline-block;">${esc(fam.name)} family</div>
    <h2>${esc(f.name)}</h2>
    <div class="fw-lead">${esc(f.lead)}</div>
    <div class="fw-sect"><div class="lbl">What it is</div><p>${esc(f.whatIs)}</p></div>
    <div class="fw-sect"><div class="lbl">Who it's from</div><p>${esc(f.whoFrom)}</p></div>
    <div class="fw-sect"><div class="lbl">What it looks at</div><ul>${f.looksAt.map((b) => `<li>${esc(b)}</li>`).join("")}</ul></div>
    <div class="fw-sect"><div class="lbl">How to read the score</div><p>${esc(f.howToRead)}</p></div>
    ${f.family === "risk" ? `<div class="fw-sect"><span class="linkpill" style="background:rgba(255,93,93,.12); color:var(--red); border-color:rgba(255,93,93,.35)">Veto layer — can block a buy on its own</span></div>` : ""}`;
  backdrop.classList.remove("hidden");
  // allow the browser to paint the un-hidden state before transitioning in
  requestAnimationFrame(() => { backdrop.classList.add("show"); panel.classList.add("show"); });
  panel.setAttribute("aria-hidden", "false");
  $("fw-close").addEventListener("click", closeFwPanel);
}
function closeFwPanel() {
  const panel = $("fw-panel"), backdrop = $("fw-backdrop");
  panel.classList.remove("show"); backdrop.classList.remove("show");
  panel.setAttribute("aria-hidden", "true");
  setTimeout(() => backdrop.classList.add("hidden"), 240);
}
$("fw-backdrop").addEventListener("click", closeFwPanel);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeFwPanel(); });

// ====================================================================
// TRADES (paper_trades)
// ====================================================================
let TRADES_BY_ID = {};
async function loadTrades() {
  const list = $("t-list");
  const { data, error } = await sb.from("paper_trades")
    .select("id,asset_id,position_id,entry_price,stop_loss,target,conviction_at_entry,position_size_pct,entry_date,exit_price,exit_date,outcome,assets(symbol)")
    .order("entry_date", { ascending: false });
  if (error) { list.innerHTML = `<div class="card err">${esc(error.message)}</div>`; return; }
  if (!data.length) { list.innerHTML = '<div class="card muted">No paper trades yet. Log your first above to start the track record.</div>'; return; }
  TRADES_BY_ID = {}; data.forEach((t) => (TRADES_BY_ID[t.id] = t));
  list.innerHTML = data.map((t) => {
    const a = t.assets || {};
    const rr = (t.target && t.entry_price && t.stop_loss) ? ((t.target - t.entry_price) / (t.entry_price - t.stop_loss)).toFixed(1) : "—";
    const oc = t.outcome || "open";
    const ocColor = oc === "win" ? "var(--green)" : oc === "loss" ? "var(--red)" : "var(--yellow)";
    const linked = !!t.position_id;
    return `<div class="card"><div class="row between">
      <span class="tk">${esc(a.symbol)}</span>
      <div class="row" style="gap:6px;">${linked ? `<span class="linkpill">↔ in Portfolio</span>` : ""}
        <span class="pill" style="background:rgba(255,255,255,.06); color:${ocColor}">${oc.toUpperCase()}</span></div></div>
      <div class="grid4" style="margin-top:10px;">
        <div class="stat"><div class="k">Entry</div><div class="v">${money(t.entry_price)}</div></div>
        <div class="stat"><div class="k">Stop</div><div class="v" style="color:var(--red)">${money(t.stop_loss)}</div></div>
        <div class="stat"><div class="k">Target</div><div class="v" style="color:var(--green)">${money(t.target)}</div></div>
        <div class="stat"><div class="k">R:R</div><div class="v">${rr}:1</div></div></div>
      <div class="muted" style="margin-top:10px; font-size:13px;">conv ${num(t.conviction_at_entry, 1)} · size ${num(t.position_size_pct, 1)}% · ${t.entry_date || ""}${oc !== "open" ? " · exit " + money(t.exit_price) : ""}</div>
      <div class="row wraprow" style="gap:6px; margin-top:8px;">
        ${oc === "open" ? `<button class="btn secondary small" data-close="${t.id}">Close (win/loss)</button>` : ""}
        <button class="btn secondary small" data-topf="${t.id}">${linked ? "Update Portfolio" : "Add to Portfolio"}</button>
        <button class="btn secondary small" data-del="${t.id}">Delete</button></div></div>`;
  }).join("");
  list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    await sb.from("paper_trades").delete().eq("id", b.dataset.del); showToast("Paper trade deleted."); loadTrades();
  }));
  list.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeTrade(b.dataset.close)));
  list.querySelectorAll("[data-topf]").forEach((b) => b.addEventListener("click", () => addTradeToPortfolio(b.dataset.topf)));
}

// Close a paper trade and, if it's linked, close the matching Portfolio holding too.
async function closeTrade(id) {
  const t = TRADES_BY_ID[id]; if (!t) return;
  const exit = parseFloat(prompt("Exit price?"));
  if (!exit) return;
  const today = new Date().toISOString().slice(0, 10);
  const outcome = exit >= (Number(t.entry_price) || 0) ? "win" : "loss";
  try {
    const { error } = await sb.from("paper_trades").update({ exit_price: exit, exit_date: today, outcome }).eq("id", id);
    if (error) throw error;
    let alsoClosed = false;
    if (t.position_id) {
      const { data: pos } = await sb.from("positions").select("quantity,entry_price,cost_basis,is_open").eq("id", t.position_id).limit(1);
      if (pos && pos[0] && pos[0].is_open) {
        const qty = Number(pos[0].quantity) || 0;
        const cost = pos[0].cost_basis != null ? Number(pos[0].cost_basis) : (Number(pos[0].entry_price) || 0) * qty;
        const realized = qty ? exit * qty - cost : null;
        await sb.from("positions").update({ is_open: false, exit_price: exit, exit_date: today, realized_pnl: realized }).eq("id", t.position_id);
        alsoClosed = true;
      }
    }
    showToast(alsoClosed ? `Trade closed (${outcome}) — linked holding closed too.` : `Trade closed (${outcome}).`);
    loadTrades();
  } catch (e) { showToast(e.message, "warn"); }
}

// One-click: create or update the matching Portfolio holding for this trade. No duplicates.
async function addTradeToPortfolio(id) {
  const t = TRADES_BY_ID[id]; if (!t) return;
  try {
    if (t.position_id) {
      const { data: pos } = await sb.from("positions").select("id").eq("id", t.position_id).limit(1);
      if (pos && pos[0]) {
        const { error } = await sb.from("positions").update({
          entry_price: t.entry_price, entry_date: t.entry_date, stop_loss: t.stop_loss, target: t.target,
        }).eq("id", t.position_id);
        if (error) throw error;
        showToast("Updated the linked holding in Portfolio."); loadTrades(); return;
      }
    }
    const { data: ins, error } = await sb.from("positions").insert({
      asset_id: t.asset_id, entry_price: t.entry_price, entry_date: t.entry_date || new Date().toISOString().slice(0, 10),
      stop_loss: t.stop_loss, target: t.target, account_type: "paper", is_open: true,
    }).select("id");
    if (error) throw error;
    await sb.from("paper_trades").update({ position_id: ins[0].id }).eq("id", id);
    showToast("Added to Portfolio."); loadTrades();
  } catch (e) { showToast(e.message, "warn"); }
}
$("t-add").addEventListener("click", async () => {
  const msg = $("t-msg");
  const sym = $("t-ticker").value.toUpperCase().trim();
  if (!sym) { msg.innerHTML = '<span class="err">Ticker required.</span>'; return; }
  try {
    msg.textContent = "Saving…";
    const asset_id = await findOrCreateAsset(sym);
    const { error } = await sb.from("paper_trades").insert({
      asset_id, entry_price: parseFloat($("t-entry").value) || null, stop_loss: parseFloat($("t-stop").value) || null,
      target: parseFloat($("t-target").value) || null, conviction_at_entry: parseFloat($("t-conv").value) || null,
      position_size_pct: parseFloat($("t-size").value) || null, entry_date: new Date().toISOString().slice(0, 10), outcome: "open",
    });
    if (error) throw error;
    ["t-ticker", "t-entry", "t-stop", "t-target", "t-conv", "t-size"].forEach((id) => ($(id).value = ""));
    msg.innerHTML = '<span class="ok">Trade logged.</span>'; loadTrades();
  } catch (e) { msg.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
});

// ====================================================================
// PORTFOLIO (positions)
// ====================================================================
let POSITIONS_BY_ID = {};
async function loadPortfolio() {
  const list = $("p-list"), summary = $("p-summary");
  const { data, error } = await sb.from("positions")
    .select("id,asset_id,quantity,entry_price,entry_date,cost_basis,account_type,is_open,stop_loss,target,assets(symbol,name)")
    .eq("is_open", true).order("entry_date", { ascending: false });
  if (error) { list.innerHTML = `<div class="card err">${esc(error.message)}</div>`; summary.innerHTML = ""; return; }
  if (!data.length) { summary.innerHTML = ""; list.innerHTML = '<div class="card muted">No holdings yet. Add one below.</div>'; return; }
  POSITIONS_BY_ID = {}; data.forEach((p) => (POSITIONS_BY_ID[p.id] = p));
  // which holdings are already linked to a paper trade (for the badge + dedup display)
  const linkedSet = new Set();
  try {
    const { data: links } = await sb.from("paper_trades").select("position_id").not("position_id", "is", null);
    (links || []).forEach((r) => linkedSet.add(r.position_id));
  } catch (e) { /* non-fatal */ }
  const valued = data.map((p) => ({ ...p, value: (Number(p.quantity) || 0) * (Number(p.entry_price) || 0) }));
  const total = valued.reduce((s, p) => s + p.value, 0);
  summary.innerHTML = `<div class="card"><div class="row between">
      <div><div class="dim" style="font-size:12px;">PORTFOLIO VALUE (at entry)</div><div class="xl">${money(total)}</div></div>
      <div class="center"><div class="dim" style="font-size:12px;">HOLDINGS</div><div class="big">${valued.length}</div></div></div></div>`;
  list.innerHTML = valued.map((p) => {
    const a = p.assets || {}, alloc = total ? (p.value / total) * 100 : 0;
    const linked = linkedSet.has(p.id);
    return `<div class="card"><div class="row between">
      <div><span class="tk">${esc(a.symbol)}</span> <span class="nm">${esc(a.name)}</span></div>
      <div class="row" style="gap:6px;">${linked ? `<span class="linkpill">↔ logged as trade</span>` : ""}
        <span class="pill" style="background:rgba(255,255,255,.06); color:var(--teal)">${esc((p.account_type || "").toUpperCase())}</span></div></div>
      <div class="grid4" style="margin-top:10px;">
        <div class="stat"><div class="k">Qty</div><div class="v">${num(p.quantity, 2)}</div></div>
        <div class="stat"><div class="k">Entry</div><div class="v">${money(p.entry_price)}</div></div>
        <div class="stat"><div class="k">Value</div><div class="v">${money(p.value)}</div></div>
        <div class="stat"><div class="k">Allocation</div><div class="v">${alloc.toFixed(1)}%</div></div></div>
      <div class="bar" style="margin-top:8px;"><div class="fill" style="width:${alloc}%; background:var(--teal)"></div></div>
      <div class="muted" style="margin-top:8px; font-size:13px;">cost basis ${money(p.cost_basis)} · bought ${p.entry_date || "—"}</div>
      <div class="row wraprow" style="gap:6px; margin-top:8px;">
        <button class="btn secondary small" data-sell="${p.id}">Sell</button>
        <button class="btn secondary small" data-logt="${p.id}">${linked ? "Update Trade" : "Log as Trade"}</button>
        <button class="btn secondary small" data-del="${p.id}">Delete</button></div></div>`;
  }).join("");
  list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => deletePosition(b.dataset.del)));
  list.querySelectorAll("[data-sell]").forEach((b) => b.addEventListener("click", () => sellPosition(b.dataset.sell)));
  list.querySelectorAll("[data-logt]").forEach((b) => b.addEventListener("click", () => logPositionAsTrade(b.dataset.logt)));
}

// Sell a holding and, if linked, close the matching paper trade too.
async function sellPosition(id) {
  const p = POSITIONS_BY_ID[id]; if (!p) return;
  const exit = parseFloat(prompt("Sell price per share?"));
  if (!exit) return;
  const today = new Date().toISOString().slice(0, 10);
  const qty = Number(p.quantity) || 0;
  const cost = p.cost_basis != null ? Number(p.cost_basis) : (Number(p.entry_price) || 0) * qty;
  try {
    const { error } = await sb.from("positions").update({
      is_open: false, exit_price: exit, exit_date: today, realized_pnl: exit * qty - cost,
    }).eq("id", id);
    if (error) throw error;
    let alsoClosed = false;
    const { data: linked } = await sb.from("paper_trades").select("id,entry_price,outcome").eq("position_id", id).limit(1);
    if (linked && linked[0] && linked[0].outcome === "open") {
      const outcome = exit >= (Number(linked[0].entry_price) || 0) ? "win" : "loss";
      await sb.from("paper_trades").update({ exit_price: exit, exit_date: today, outcome }).eq("id", linked[0].id);
      alsoClosed = true;
    }
    showToast(alsoClosed ? "Holding sold — linked paper trade closed too." : "Holding sold.");
    loadPortfolio();
  } catch (e) { showToast(e.message, "warn"); }
}

// Delete a holding; if a paper trade is linked, flag it (the link auto-nulls on delete).
async function deletePosition(id) {
  if (!confirm("Delete this holding entirely? (Use Sell instead to keep it for tax records.)")) return;
  try {
    const { data: linked } = await sb.from("paper_trades").select("id,post_analysis").eq("position_id", id).limit(1);
    let flagged = false;
    if (linked && linked[0]) {
      const flag = "⚠ Linked Portfolio holding was deleted on " + new Date().toISOString().slice(0, 10) + ".";
      const note = linked[0].post_analysis ? linked[0].post_analysis + " " + flag : flag;
      await sb.from("paper_trades").update({ post_analysis: note }).eq("id", linked[0].id);
      flagged = true;
    }
    await sb.from("positions").delete().eq("id", id);
    showToast(flagged ? "Holding deleted — linked paper trade flagged." : "Holding deleted.", flagged ? "warn" : "ok");
    loadPortfolio();
  } catch (e) { showToast(e.message, "warn"); }
}

// One-click: create or update the matching paper trade for this holding. No duplicates.
async function logPositionAsTrade(id) {
  const p = POSITIONS_BY_ID[id]; if (!p) return;
  try {
    const { data: existing } = await sb.from("paper_trades").select("id").eq("position_id", id).limit(1);
    if (existing && existing[0]) {
      const { error } = await sb.from("paper_trades").update({
        entry_price: p.entry_price, stop_loss: p.stop_loss, target: p.target, entry_date: p.entry_date,
      }).eq("id", existing[0].id);
      if (error) throw error;
      showToast("Updated the linked paper trade."); loadPortfolio(); return;
    }
    const { error } = await sb.from("paper_trades").insert({
      asset_id: p.asset_id, entry_price: p.entry_price, stop_loss: p.stop_loss, target: p.target,
      entry_date: p.entry_date || new Date().toISOString().slice(0, 10), outcome: "open", position_id: id,
    });
    if (error) throw error;
    showToast("Logged as a paper trade."); loadPortfolio();
  } catch (e) { showToast(e.message, "warn"); }
}
$("p-add").addEventListener("click", async () => {
  const msg = $("p-msg");
  const sym = $("p-ticker").value.toUpperCase().trim();
  if (!sym) { msg.innerHTML = '<span class="err">Ticker required.</span>'; return; }
  try {
    msg.textContent = "Saving…";
    const asset_id = await findOrCreateAsset(sym);
    const { error } = await sb.from("positions").insert({
      asset_id, quantity: parseFloat($("p-qty").value) || null, entry_price: parseFloat($("p-entry").value) || null,
      cost_basis: parseFloat($("p-cost").value) || null, account_type: $("p-acct").value,
      entry_date: $("p-date").value || null, is_open: true,
    });
    if (error) throw error;
    ["p-ticker", "p-qty", "p-entry", "p-cost", "p-date"].forEach((id) => ($(id).value = ""));
    msg.innerHTML = '<span class="ok">Holding added.</span>'; loadPortfolio();
  } catch (e) { msg.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
});

// ====================================================================
// SCORECARD (framework_scores aggregated)
// ====================================================================
async function loadScorecard() {
  const list = $("sc-list");
  const { data, error } = await sb.from("framework_scores").select("framework_name,verdict,score").limit(5000);
  if (error) { list.innerHTML = `<div class="card err">${esc(error.message)}</div>`; return; }
  if (!data.length) { list.innerHTML = '<div class="card muted">No framework history yet — run scans to build the scorecard.</div>'; return; }
  const DESC = {
    "Graham": "Deep value — hunts for cheap, low-debt companies trading below what they're worth (Benjamin Graham).",
    "Buffett": "Quality compounder — durable, high-margin businesses worth holding for years (Warren Buffett).",
    "Lynch": "Growth at a reasonable price — fast growers not yet overpriced (Peter Lynch).",
    "Magic Formula": "Cheap price + high return on capital combined into one ranking (Joel Greenblatt).",
    "Momentum": "Trend-following — stocks going up tend to keep going up (Cliff Asness).",
    "Marks": "Contrarian / second-level thinking — value where the crowd is fearful (Howard Marks).",
    "Taleb": "Antifragility & risk — favours low debt and survival through shocks (Nassim Taleb).",
  };
  const agg = {};
  data.forEach((r) => {
    const f = agg[r.framework_name] || (agg[r.framework_name] = { buy: 0, neutral: 0, avoid: 0, sum: 0, n: 0 });
    if (r.verdict === "BUY") f.buy++; else if (r.verdict === "AVOID") f.avoid++; else f.neutral++;
    f.sum += Number(r.score) || 0; f.n++;
  });
  list.innerHTML = Object.entries(agg).sort((a, b) => (b[1].sum / b[1].n) - (a[1].sum / a[1].n)).map(([name, f]) => {
    const avg = f.sum / f.n, total = f.n;
    const w = (x) => (total ? (x / total) * 100 : 0);
    return `<div class="card"><div class="row between">
      <div class="tk" style="font-size:17px;">${esc(name)}</div>
      <div class="big" style="color:${convColor(avg)}">${avg.toFixed(1)}<span class="dim" style="font-size:13px;"> / 10 avg</span></div></div>
      <div class="fieldtip" style="margin-top:2px;">${esc(DESC[name] || "")}</div>
      <div class="bar" style="margin-top:10px; display:flex;">
        <div style="width:${w(f.buy)}%; background:var(--green); height:100%;"></div>
        <div style="width:${w(f.neutral)}%; background:var(--yellow); height:100%;"></div>
        <div style="width:${w(f.avoid)}%; background:var(--red); height:100%;"></div></div>
      <div class="row between" style="margin-top:8px; font-size:13px;">
        <span style="color:var(--green)">${f.buy} buy</span>
        <span style="color:var(--yellow)">${f.neutral} neutral</span>
        <span style="color:var(--red)">${f.avoid} avoid</span>
        <span class="muted">${total} calls</span></div>
      <div class="fieldtip" style="margin-top:6px;">Average score ${avg.toFixed(1)}/10 across ${total} calls (higher = this strategy has been more positive overall). The bar shows its split of buy / neutral / avoid.</div></div>`;
  }).join("");
}

// ====================================================================
// TAX — Canadian capital-gains report (from sold positions)
// ====================================================================
let TAX_ROWS = [];
const ACCT_LABEL = { non_registered: "Non-registered", tfsa: "TFSA", rrsp: "RRSP", paper: "Paper" };

async function loadTax() {
  const body = $("tax-body");
  const { data, error } = await sb.from("positions")
    .select("entry_date,entry_price,quantity,cost_basis,account_type,exit_date,exit_price,realized_pnl,assets(symbol)")
    .eq("is_open", false).not("exit_date", "is", null).order("exit_date", { ascending: false });
  if (error) { body.innerHTML = `<div class="card err">${esc(error.message)}</div>`; return; }
  TAX_ROWS = (data || []).map((p) => {
    const qty = Number(p.quantity) || 0, buy = Number(p.entry_price) || 0, sell = Number(p.exit_price) || 0;
    const cost = p.cost_basis != null ? Number(p.cost_basis) : buy * qty;
    return {
      symbol: (p.assets || {}).symbol, account: p.account_type, buyDate: p.entry_date, buyPrice: buy,
      qty, cost, sellDate: p.exit_date, sellPrice: sell, proceeds: sell * qty,
      gain: p.realized_pnl != null ? Number(p.realized_pnl) : sell * qty - cost,
      year: (p.exit_date || "").slice(0, 4),
    };
  });
  const years = [...new Set(TAX_ROWS.map((r) => r.year).filter(Boolean))].sort().reverse();
  const sel = $("tax-year"); const cur = sel.value;
  sel.innerHTML = `<option value="all">All years</option>` + years.map((y) => `<option>${y}</option>`).join("");
  if (cur) sel.value = cur;
  renderTax();
}

function taxTable(rows) {
  const r2 = (v) => "$" + Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const gl = (v) => `<span style="color:${v >= 0 ? "var(--green)" : "var(--red)"}">${v >= 0 ? "" : "−"}${r2(Math.abs(v))}</span>`;
  const head = `<tr><th class="l">Ticker</th><th>Buy date</th><th>Buy $</th><th>Qty</th><th>Cost basis</th>
    <th>Sell date</th><th>Sell $</th><th>Proceeds</th><th>Gain / loss</th></tr>`;
  const body = rows.map((r) => `<tr>
    <td class="l">${esc(r.symbol)}</td><td>${r.buyDate || "—"}</td><td>${r2(r.buyPrice)}</td><td>${num(r.qty, 2)}</td>
    <td>${r2(r.cost)}</td><td>${r.sellDate || "—"}</td><td>${r2(r.sellPrice)}</td><td>${r2(r.proceeds)}</td><td>${gl(r.gain)}</td></tr>`).join("");
  const total = rows.reduce((s, r) => s + r.gain, 0);
  const foot = `<tr><th class="l" colspan="8">Net gain / loss</th><th>${gl(total)}</th></tr>`;
  return { html: `<div class="scrollx"><table class="tax">${head}${body}${foot}</table></div>`, total };
}

function renderTax() {
  const body = $("tax-body"); const yr = ($("tax-year").value) || "all";
  const rows = TAX_ROWS.filter((r) => yr === "all" || r.year === yr);
  if (!rows.length) { body.innerHTML = '<div class="card muted">No sold holdings yet. In Portfolio, use <b>Sell</b> on a holding to record an exit — it appears here for tax reporting.</div>'; return; }
  const taxable = rows.filter((r) => r.account === "non_registered");
  const sheltered = rows.filter((r) => r.account === "tfsa" || r.account === "rrsp");

  let html = "";
  // Taxable (non-registered)
  if (taxable.length) {
    const t = taxTable(taxable);
    const taxablePortion = t.total > 0 ? t.total * 0.5 : 0;
    html += `<div class="card"><div class="big" style="margin-bottom:6px;">Taxable — Non-registered</div>
      <div class="fieldtip" style="margin-bottom:10px;">These gains/losses are reportable to the CRA (Schedule 3). In Canada, <b>50% of a net capital gain is taxable</b>; net capital losses can offset gains in other years.</div>
      ${t.html}
      <div class="grid2" style="margin-top:12px;">
        <div class="stat"><div class="k">Net capital gain / loss</div><div class="v" style="color:${t.total >= 0 ? "var(--green)" : "var(--red)"}">${t.total >= 0 ? "" : "−"}$${Math.abs(t.total).toLocaleString(undefined, { maximumFractionDigits: 2 })}</div></div>
        <div class="stat"><div class="k">Taxable portion (50%)</div><div class="v">$${taxablePortion.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div></div></div>
      ${t.total < 0 ? `<div class="fieldtip" style="margin-top:8px;">A net loss isn't taxed — it can be carried back 3 years or forward to offset future capital gains.</div>` : ""}</div>`;
  } else {
    html += `<div class="card muted">No non-registered (taxable) sales in this period.</div>`;
  }
  // Sheltered (TFSA / RRSP)
  if (sheltered.length) {
    const s = taxTable(sheltered);
    html += `<div class="card"><div class="big" style="margin-bottom:6px;">Tax-sheltered — TFSA / RRSP</div>
      <div class="fieldtip" style="margin-bottom:10px;">For your records only. Gains inside a <b>TFSA or RRSP are not taxable</b> and are <b>not</b> reported as capital gains.</div>
      ${s.html}</div>`;
  }
  html += `<div class="card"><div class="fieldtip"><b>Not tax advice.</b> Cost basis shown is per-holding; the CRA requires the <b>average cost (ACB)</b> across all units of the same security — if you bought a stock in multiple lots, confirm the averaged figure. Verify everything with a tax professional before filing.</div></div>`;
  body.innerHTML = html;
}

function taxCSV() {
  const yr = ($("tax-year").value) || "all";
  const rows = TAX_ROWS.filter((r) => yr === "all" || r.year === yr);
  if (!rows.length) { alert("Nothing to export for this period."); return; }
  const header = ["Ticker", "Account", "Taxable", "Buy date", "Buy price", "Quantity", "Cost basis", "Sell date", "Sell price", "Proceeds", "Gain/Loss"];
  const lines = [header.join(",")];
  rows.forEach((r) => {
    lines.push([r.symbol, ACCT_LABEL[r.account] || r.account, r.account === "non_registered" ? "Yes" : "No (sheltered)",
      r.buyDate || "", r.buyPrice.toFixed(2), r.qty, r.cost.toFixed(2), r.sellDate || "", r.sellPrice.toFixed(2),
      r.proceeds.toFixed(2), r.gain.toFixed(2)].join(","));
  });
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `iip-capital-gains-${yr}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ====================================================================
// ALERTS (rules engine — manage rows in `alerts`)
// ====================================================================
const ALERT_NEEDS = {
  price_above: { ticker: true, thr: true, thrLabel: "Price $", hint: "Pings you the moment the stock first crosses above this price." },
  price_below: { ticker: true, thr: true, thrLabel: "Price $", hint: "Pings you when the stock first drops below this price." },
  rsi_level: { ticker: true, thr: true, thrLabel: "RSI level (e.g. 30)", hint: "Pings you when RSI falls to this level or lower — often a sign a stock is oversold." },
  signal_flip: { ticker: true, thr: false, hint: "Pings you when this stock's overall buy/avoid call changes from one scan to the next." },
  cycle_change: { ticker: false, thr: false, hint: "Pings you when Bitcoin moves into a new phase of its ~4-year cycle (e.g. mid-cycle → late-cycle)." },
};
function alertRuleUI() {
  const t = $("al-type").value, cfg = ALERT_NEEDS[t];
  $("al-ticker-wrap").style.display = cfg.ticker ? "" : "none";
  $("al-thr-wrap").style.display = cfg.thr ? "" : "none";
  if (cfg.thr) $("al-thr-label").textContent = cfg.thrLabel;
  $("al-hint").textContent = cfg.hint;
}
function alertDesc(a) {
  const s = (a.assets || {}).symbol || "a stock", thr = a.threshold;
  switch (a.rule_type) {
    case "price_above": return `When <b>${esc(s)}</b> rises above <b>$${thr}</b>`;
    case "price_below": return `When <b>${esc(s)}</b> falls below <b>$${thr}</b>`;
    case "rsi_level": return `When <b>${esc(s)}</b> RSI drops to <b>${thr}</b> or below (oversold)`;
    case "signal_flip": return `When <b>${esc(s)}</b>'s buy/avoid signal flips`;
    case "cycle_change": return `When <b>Bitcoin's</b> cycle phase changes`;
    default: return esc(a.rule_type);
  }
}
async function loadAlerts() {
  alertRuleUI();
  const list = $("al-list");
  const { data, error } = await sb.from("alerts").select("id,rule_type,threshold,channel,is_active,last_triggered,assets(symbol)").order("created_at", { ascending: false });
  if (error) { list.innerHTML = `<div class="card err">${esc(error.message)}</div>`; return; }
  if (!data.length) { list.innerHTML = '<div class="card muted">No alerts yet. Create one above.</div>'; return; }
  list.innerHTML = data.map((a) => {
    const chTxt = a.channel === "none" ? "record only" : a.channel;
    return `<div class="card"><div class="row between">
      <div class="plan-line" style="font-size:15px;">${alertDesc(a)}</div>
      <span class="pill" style="background:rgba(255,255,255,.06); color:${a.is_active ? "var(--green)" : "var(--dim)"}">${a.is_active ? "ON" : "OFF"}</span></div>
      <div class="row between" style="margin-top:8px; font-size:13px;">
        <span class="muted">via ${esc(chTxt)}${a.last_triggered ? " · last fired " + new Date(a.last_triggered).toLocaleDateString() : " · never fired"}</span>
        <span class="row" style="gap:6px;">
          <button class="btn secondary small" data-toggle="${a.id}" data-on="${a.is_active ? 1 : 0}">${a.is_active ? "Turn off" : "Turn on"}</button>
          <button class="btn secondary small" data-del="${a.id}">Delete</button></span></div></div>`;
  }).join("");
  list.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", async () => {
    await sb.from("alerts").delete().eq("id", b.dataset.del); loadAlerts();
  }));
  list.querySelectorAll("[data-toggle]").forEach((b) => b.addEventListener("click", async () => {
    await sb.from("alerts").update({ is_active: b.dataset.on !== "1" }).eq("id", b.dataset.toggle); loadAlerts();
  }));
}
async function addAlert() {
  const msg = $("al-msg"), t = $("al-type").value, cfg = ALERT_NEEDS[t];
  try {
    let asset_id = null;
    if (cfg.ticker) {
      const sym = $("al-ticker").value.toUpperCase().trim();
      if (!sym) { msg.innerHTML = '<span class="err">Ticker required for this alert.</span>'; return; }
      asset_id = await findOrCreateAsset(sym);
    }
    let threshold = null;
    if (cfg.thr) {
      threshold = parseFloat($("al-thr").value);
      if (isNaN(threshold)) { msg.innerHTML = '<span class="err">Enter a number for the level.</span>'; return; }
    }
    msg.textContent = "Saving…";
    const { error } = await sb.from("alerts").insert({
      asset_id, rule_type: t, threshold, channel: $("al-channel").value, is_active: true,
    });
    if (error) throw error;
    $("al-ticker").value = ""; $("al-thr").value = "";
    msg.innerHTML = '<span class="ok">Alert created.</span>'; loadAlerts();
  } catch (e) { msg.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
}

// ====================================================================
// SETTINGS
// ====================================================================
const FREQ = ["manual", "minute", "hourly", "daily", "weekly", "monthly", "off"];
const SLICES = ["full", "top100", "top50", "top25", "movers", "watchlist", "sector", "custom"];
// Claude models selectable for the metered deep-analysis step. Sonnet is the default
// (good balance of quality and cost); Opus is the most capable.
// TO ADD A NEW MODEL: add one {id,label} here and one pricing line in engine/qualitative.py PRICING.
const MODELS = [
  { id: "claude-sonnet-4-6", label: "Sonnet 4.6 — balanced (default)" },
  { id: "claude-opus-4-8", label: "Opus 4.8 — most capable (pricier)" },
  { id: "claude-haiku-4-5", label: "Haiku 4.5 — fastest/cheapest" },
];
const DEFAULT_MODEL = "claude-sonnet-4-6";
let SETTINGS_CACHE = {};

async function loadSettings() {
  const body = $("set-body");
  const { data, error } = await sb.from("settings").select("key,value");
  if (error) { body.innerHTML = `<div class="card err">${esc(error.message)}</div>`; return; }
  SETTINGS_CACHE = {}; data.forEach((r) => (SETTINGS_CACHE[r.key] = r.value));
  const g = (k, d) => (SETTINGS_CACHE[k] !== undefined ? SETTINGS_CACHE[k] : d);
  const freqs = g("scan_frequencies", {});
  const channels = g("alert_channels", {});

  // Claude API spend this month (spec §2.8 — cost visible in the dashboard)
  const cap = Number(g("monthly_budget_cap", 25));
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  let spent = 0, calls = 0;
  try {
    const { data: costs } = await sb.from("api_costs").select("cost_usd").gte("call_timestamp", monthStart.toISOString());
    calls = (costs || []).length;
    spent = (costs || []).reduce((s, c) => s + (Number(c.cost_usd) || 0), 0);
  } catch (e) { /* table readable once logged in */ }
  const pctUsed = cap ? Math.min(100, (spent / cap) * 100) : 0;
  const spendColor = pctUsed >= 100 ? "var(--red)" : pctUsed >= Number(g("budget_alert_threshold_pct", 75)) ? "var(--yellow)" : "var(--green)";

  const freqSel = (src) => `<div><label class="fld">${src[0].toUpperCase() + src.slice(1)}</label>
    <select data-freq="${src}">${FREQ.map((f) => `<option ${freqs[src] === f ? "selected" : ""}>${f}</option>`).join("")}</select></div>`;

  body.innerHTML = `
    <div class="card">
      <div class="big" style="margin-bottom:6px;">Scan frequency</div>
      <div class="muted" style="margin-bottom:8px;">How often each free data source is scanned.</div>
      <div class="grid3">${["price", "trends", "reddit", "bitcoin", "grok_x"].map(freqSel).join("")}</div>
    </div>
    <div class="card">
      <div class="big" style="margin-bottom:6px;">Universe</div>
      <label class="fld">Default slice to scan</label>
      <select id="set-slice">${SLICES.map((s) => `<option ${g("default_universe_slice") === s ? "selected" : ""}>${s}</option>`).join("")}</select>
    </div>
    <div class="card" style="border-color:var(--yellow);">
      <div class="big" style="margin-bottom:4px;">Claude API (metered)</div>
      <div class="fieldtip" style="margin-bottom:8px;">The optional deep-analysis step. It costs money each run. Keep OFF unless you intend to spend; the budget cap below is your safety limit.</div>
      <label class="fld">Enabled</label>
      <select id="set-claude"><option value="false" ${!g("claude_api_enabled") ? "selected" : ""}>OFF (default — no spend)</option>
        <option value="true" ${g("claude_api_enabled") ? "selected" : ""}>ON (will incur cost)</option></select>
      <label class="fld">Model</label>
      <select id="set-model">${MODELS.map((m) => `<option value="${m.id}" ${g("claude_model", DEFAULT_MODEL) === m.id ? "selected" : ""}>${m.label}</option>`).join("")}</select>
      <div class="fieldtip" style="margin-top:4px;">Which Claude model the deep-analysis step uses. Sonnet is the default; Opus is sharper but costs more.</div>
      <div class="grid2" style="margin-top:6px;">
        <div><label class="fld">Monthly budget cap $</label><input id="set-cap" type="number" step="0.01" value="${g("monthly_budget_cap", 25)}" /></div>
        <div><label class="fld">Alert at % of budget</label><input id="set-alertpct" type="number" value="${g("budget_alert_threshold_pct", 75)}" /></div>
      </div>
    </div>
    <div class="card">
      <div class="big" style="margin-bottom:6px;">Claude API spend this month</div>
      <div class="row between"><div class="xl" style="color:${spendColor}">$${spent.toFixed(2)}</div>
        <div class="muted" style="text-align:right;">of $${cap.toFixed(2)} cap<br><span class="dim">${calls} call${calls === 1 ? "" : "s"}</span></div></div>
      <div class="bar" style="margin-top:8px;"><div class="fill" style="width:${pctUsed}%; background:${spendColor}"></div></div>
      <div class="fieldtip" style="margin-top:6px;">The only part of the system that costs money. Spend stops automatically at the cap; you're alerted at ${g("budget_alert_threshold_pct", 75)}%.</div>
    </div>
    <div class="card">
      <div class="big" style="margin-bottom:6px;">Run Deep Analysis <span class="dim" style="font-size:13px;">(uses Claude API — metered)</span></div>
      <div class="fieldtip" style="margin-bottom:10px;">Runs the 4 qualitative frameworks (Wood, Thiel, Shiller, Camillo) on the latest scan's top candidates using the Claude API. It's <b>off by default</b> and never runs automatically — it only spends when you start it, and it stops at your cap.</div>
      <button id="set-deep" class="btn" ${g("claude_api_enabled") ? "" : "disabled"} style="width:100%;">Run Deep Analysis now</button>
      <div id="set-deep-msg" class="fieldtip" style="margin-top:8px;">${g("claude_api_enabled") ? "" : "Turn Claude API ON above and save, then this button activates."}</div>
    </div>
    <div class="card">
      <div class="big" style="margin-bottom:6px;">Alerts</div>
      <div class="grid2">
        <div><label class="fld">Email alerts</label><select id="set-email"><option value="false" ${!channels.email_enabled ? "selected" : ""}>Off</option><option value="true" ${channels.email_enabled ? "selected" : ""}>On</option></select></div>
        <div><label class="fld">SMS alerts</label><select id="set-sms"><option value="false" ${!channels.sms_enabled ? "selected" : ""}>Off</option><option value="true" ${channels.sms_enabled ? "selected" : ""}>On</option></select></div>
      </div>
    </div>
    <button id="set-save" class="btn" style="width:100%;">Save settings</button>
    <div id="set-msg" class="center" style="font-size:14px; margin:10px 0;"></div>
    <div class="card" style="margin-top:12px;">
      <div class="big" style="margin-bottom:6px;">Run a scan</div>
      <div class="muted">Scans are run by the engine (locally or on Railway), not from this page. On-demand "Run now" wiring comes with the scheduler step. Settings you save here are read by the engine on its next run.</div>
    </div>`;

  $("set-save").addEventListener("click", saveSettings);
  const deep = $("set-deep");
  if (deep) deep.addEventListener("click", () => {
    $("set-deep-msg").innerHTML = "Deep analysis runs in the engine (where the Claude key lives), not from this page. "
      + "It runs on demand via <code>python -m engine.run_qualitative</code>, and on-demand triggering from this button "
      + "turns on once the scan engine is deployed. Your budget cap and the alert threshold apply automatically.";
  });
}
async function saveSettings() {
  const msg = $("set-msg");
  try {
    msg.textContent = "Saving…";
    const freqs = {};
    document.querySelectorAll("[data-freq]").forEach((s) => (freqs[s.dataset.freq] = s.value));
    const channels = Object.assign({}, SETTINGS_CACHE.alert_channels || {}, {
      email_enabled: $("set-email").value === "true", sms_enabled: $("set-sms").value === "true",
    });
    const rows = [
      { key: "scan_frequencies", value: freqs },
      { key: "default_universe_slice", value: $("set-slice").value },
      { key: "claude_api_enabled", value: $("set-claude").value === "true" },
      { key: "claude_model", value: $("set-model").value },
      { key: "monthly_budget_cap", value: parseFloat($("set-cap").value) || 0 },
      { key: "budget_alert_threshold_pct", value: parseFloat($("set-alertpct").value) || 0 },
      { key: "alert_channels", value: channels },
    ];
    const { error } = await sb.from("settings").upsert(rows, { onConflict: "key" });
    if (error) throw error;
    msg.innerHTML = '<span class="ok">Saved.</span>';
  } catch (e) { msg.innerHTML = `<span class="err">${esc(e.message)}</span>`; }
}

init();

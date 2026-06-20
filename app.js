/* IIP dashboard — reads Supabase only (spec §7). Magic-link auth; RLS keeps data
   private to the owner. Tabs: Candidates, Bitcoin, Analyzer (build §8 step 4). */

const cfg = window.IIP_CONFIG;
const sb = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);
const el = (sel) => document.querySelector(sel);

// ---------- helpers ----------
const money = (v) => (v == null ? "—" : "$" + Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }));
const num = (v, d = 1) => (v == null ? "—" : Number(v).toFixed(d));
const pct = (v, d = 1) => (v == null ? "—" : (v > 0 ? "+" : "") + Number(v).toFixed(d) + "%");

const ACTION_COLOR = { buy: "var(--green)", watch: "var(--teal)", wait: "var(--yellow)", avoid: "var(--red)" };
const VERDICT_COLOR = { BUY: "var(--green)", NEUTRAL: "var(--yellow)", AVOID: "var(--red)" };

function convColor(score) {
  if (score >= 7) return "var(--green)";
  if (score >= 5.5) return "var(--teal)";
  if (score >= 4) return "var(--yellow)";
  return "var(--red)";
}

// ---------- auth ----------
async function init() {
  const { data: { session } } = await sb.auth.getSession();
  showAuth(session);
  sb.auth.onAuthStateChange((_e, s) => showAuth(s));
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
  $("send-link").disabled = true;
  msg.textContent = "Sending…";
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.origin + location.pathname },
  });
  $("send-link").disabled = false;
  msg.innerHTML = error
    ? `<span class="err">${error.message}</span>`
    : '<span class="ok">Check your email and click the login link.</span>';
});

$("logout").addEventListener("click", () => sb.auth.signOut());

// ---------- tabs ----------
document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    ["candidates", "bitcoin", "analyzer"].forEach((v) =>
      $("view-" + v).classList.toggle("hidden", v !== t.dataset.tab)
    );
  });
});

$("refresh").addEventListener("click", loadAll);

// ---------- data ----------
async function latestScan() {
  const { data, error } = await sb
    .from("scans")
    .select("id,scan_timestamp,universe_slice")
    .eq("status", "complete")
    .order("scan_timestamp", { ascending: false })
    .limit(1);
  if (error) throw error;
  return data && data[0];
}

async function loadAll() {
  try {
    const scan = await latestScan();
    await Promise.all([loadCandidates(scan), loadBitcoin(scan)]);
  } catch (e) {
    $("cand-list").innerHTML = `<div class="card err">Error: ${e.message}</div>`;
  }
}

async function loadCandidates(scan) {
  const meta = $("cand-meta");
  const list = $("cand-list");
  if (!scan) { meta.textContent = "No scans yet"; list.innerHTML = '<div class="card muted">Run a scan to see candidates.</div>'; return; }

  meta.textContent = `Latest scan · ${new Date(scan.scan_timestamp).toLocaleString()} · ${scan.universe_slice}`;
  const { data, error } = await sb
    .from("recommendations")
    .select("conviction,action,entry_target,stop_loss,exit_target,position_size_pct,time_horizon,rationale,assets(symbol,name,sector)")
    .eq("scan_id", scan.id)
    .order("conviction", { ascending: false });
  if (error) { list.innerHTML = `<div class="card err">${error.message}</div>`; return; }
  if (!data.length) { list.innerHTML = '<div class="card muted">No recommendations in the latest scan.</div>'; return; }

  list.innerHTML = data.map((r, i) => {
    const a = r.assets || {};
    const c = Number(r.conviction);
    return `<div class="card">
      <div class="row between">
        <div class="row" style="gap:12px;">
          <span class="dim" style="width:18px;">${i + 1}</span>
          <div>
            <span class="tk">${a.symbol || "?"}</span>
            <div class="nm">${a.name || ""}${a.sector ? " · " + a.sector : ""}</div>
          </div>
        </div>
        <div class="center">
          <div class="big" style="color:${convColor(c)}">${c.toFixed(2)}</div>
          <span class="pill" style="background:rgba(255,255,255,.06); color:${ACTION_COLOR[r.action] || "var(--muted)"}">${(r.action || "").toUpperCase()}</span>
        </div>
      </div>
      <div class="grid4" style="margin-top:12px;">
        <div class="stat"><div class="k">Entry</div><div class="v">${money(r.entry_target)}</div></div>
        <div class="stat"><div class="k">Stop</div><div class="v" style="color:var(--red)">${money(r.stop_loss)}</div></div>
        <div class="stat"><div class="k">Target</div><div class="v" style="color:var(--green)">${money(r.exit_target)}</div></div>
        <div class="stat"><div class="k">Size</div><div class="v">${num(r.position_size_pct, 2)}%</div></div>
      </div>
      ${r.rationale ? `<div class="muted" style="margin-top:10px; font-size:14px;">${r.rationale}</div>` : ""}
    </div>`;
  }).join("");
}

async function loadBitcoin(scan) {
  const box = $("btc");
  let snap = null;
  if (scan) {
    const { data } = await sb.from("bitcoin_snapshots").select("*").eq("scan_id", scan.id).limit(1);
    snap = data && data[0];
  }
  if (!snap) {
    const { data } = await sb.from("bitcoin_snapshots").select("*").order("created_at", { ascending: false }).limit(1);
    snap = data && data[0];
  }
  if (!snap) { box.innerHTML = '<div class="card muted">No Bitcoin snapshot yet.</div>'; return; }

  const comp = (snap.raw && snap.raw.components) || {};
  const compRows = Object.entries(comp).map(([k, v]) => {
    const s = Number(v.score || 0);
    return `<div style="margin-bottom:10px;">
      <div class="row between" style="font-size:14px;"><span style="text-transform:capitalize;">${k}</span><span class="muted">${num(s, 1)} · ${v.note || ""}</span></div>
      <div class="bar"><div class="fill" style="width:${(s / 10) * 100}%; background:${convColor(s)}"></div></div>
    </div>`;
  }).join("");

  box.innerHTML = `
    <div class="card">
      <div class="row between">
        <div><div class="dim" style="font-size:12px;">BITCOIN</div><div class="big">${money(snap.price)}</div></div>
        <div class="center"><div class="dim" style="font-size:12px;">VERDICT</div>
          <div class="big" style="color:${convColor(Number(snap.composite_score))}">${snap.verdict || "—"}</div></div>
      </div>
      <div class="muted" style="margin-top:8px;">${snap.position_guidance || ""}</div>
    </div>
    <div class="card">
      <div class="grid4">
        <div class="stat"><div class="k">Composite</div><div class="v" style="color:${convColor(Number(snap.composite_score))}">${num(snap.composite_score, 1)}/10</div></div>
        <div class="stat"><div class="k">RSI 14</div><div class="v">${num(snap.rsi_14, 0)}</div></div>
        <div class="stat"><div class="k">vs ATH</div><div class="v">${pct(snap.ath_change_pct)}</div></div>
        <div class="stat"><div class="k">Fear/Greed</div><div class="v">${num(snap.fear_greed, 0)}</div></div>
        <div class="stat"><div class="k">50d MA</div><div class="v">${money(snap.ma_50)}</div></div>
        <div class="stat"><div class="k">200d MA</div><div class="v">${money(snap.ma_200)}</div></div>
      </div>
      <div class="muted" style="margin-top:12px; font-size:14px;">${snap.cycle_phase || ""}</div>
    </div>
    ${compRows ? `<div class="card"><div class="dim" style="font-size:12px; margin-bottom:10px;">SIGNAL BREAKDOWN</div>${compRows}</div>` : ""}
  `;
}

// ---------- analyzer (ported verbatim from IIP_Command_Center.html frameworks()) ----------
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function verdictFor(s) { return s >= 7 ? "BUY" : s >= 5 ? "NEUTRAL" : "AVOID"; }

function frameworks(d) {
  const out = [];
  let gs = 5; if (d.fcf > 5) gs += 2; else if (d.fcf > 2) gs += 1; else gs -= 1;
  if (d.de < 0.5) gs += 1; else if (d.de > 2) gs -= 2; if (d.eps > 10) gs += 1; else if (d.eps < 0) gs -= 2;
  out.push(["Graham", "Deep value", clamp(gs, 1, 10)]);
  let bs = 5; if (d.margin > 50) bs += 2; else if (d.margin > 35) bs += 1; else if (d.margin < 20) bs -= 1;
  if (d.eps > 10 && d.eps < 50) bs += 1; if (d.de < 0.5) bs += 1; else if (d.de > 1.5) bs -= 1; if (d.fcf > 4) bs += 1; else if (d.fcf < 1) bs -= 1;
  out.push(["Buffett", "Quality compounder", clamp(bs, 1, 10)]);
  let ls = 5; if (d.eps >= 20 && d.eps <= 50) ls += 3; else if (d.eps > 50 && d.eps <= 100) ls += 2; else if (d.eps > 100) ls += 1; else if (d.eps > 10) ls += 1; else if (d.eps < 0) ls -= 2;
  if (d.rev > 10) ls += 1; else if (d.rev < 0) ls -= 1; if (d.rsi > 75) ls -= 1; else if (d.rsi < 35) ls += 1; if (d.rel > 30) ls += 1; else if (d.rel < -20) ls -= 1;
  out.push(["Lynch", "Growth at reasonable price", clamp(ls, 1, 10)]);
  let ms = 5; if (d.fcf > 6) ms += 2; else if (d.fcf > 3) ms += 1; else if (d.fcf < 1) ms -= 2;
  let roic = d.margin / (1 + d.de) / 100; if (roic > 0.30) ms += 2; else if (roic > 0.15) ms += 1; else if (roic < 0.05) ms -= 1; if (d.eps > 15) ms += 1;
  out.push(["Magic Formula", "Earnings yield × ROIC", clamp(ms, 1, 10)]);
  let mo = 5; if (d.rel > 50) mo += 3; else if (d.rel > 20) mo += 2; else if (d.rel > 0) mo += 1; else mo -= 2;
  if (d.ma > 10) mo += 1; else if (d.ma > 0) mo += 0.5; else mo -= 1; if (d.rsi > 80) mo -= 1; else if (d.rsi >= 45 && d.rsi <= 65) mo += 1;
  out.push(["Momentum", "Trend persistence", clamp(mo, 1, 10)]);
  let cs = 5; if (d.eps > 15 && d.rel < -10) cs += 3; else if (d.eps > 10 && d.rsi < 40) cs += 2; else if (d.rsi > 75 && d.rel > 50) cs -= 2; else if (d.rsi > 70 && d.eps < 10) cs -= 1;
  out.push(["Marks", "Contrarian / 2nd level", clamp(cs, 1, 10)]);
  let ts = 5; if (d.de < 0.3) ts += 2; else if (d.de < 0.7) ts += 1; else if (d.de > 1.5) ts -= 2; else if (d.de > 2.5) ts -= 3;
  if (d.margin > 50) ts += 1; else if (d.margin < 20) ts -= 1; if (d.fcf > 4) ts += 1; else if (d.fcf < 1) ts -= 1; if (d.rel > 100) ts -= 1;
  out.push(["Taleb", "Antifragility / risk", clamp(ts, 1, 10)]);
  return out;
}

$("run-analyzer").addEventListener("click", () => {
  const g = (id) => parseFloat($(id).value) || 0;
  const d = { rev: g("in-rev"), eps: g("in-eps"), margin: g("in-margin"), fcf: g("in-fcf"),
              rel: g("in-rel"), rsi: g("in-rsi") || 50, de: g("in-de"), ma: g("in-ma") };
  const fws = frameworks(d);
  let buys = 0, avoids = 0, sum = 0;
  const rows = fws.map((f) => {
    const v = verdictFor(f[2]); if (v === "BUY") buys++; if (v === "AVOID") avoids++; sum += f[2];
    return `<div class="card"><div class="row between">
      <div><div class="tk" style="font-size:16px;">${f[0]}</div><div class="nm">${f[1]}</div></div>
      <div class="row" style="gap:14px;">
        <span class="pill" style="background:rgba(255,255,255,.06); color:${VERDICT_COLOR[v]}">${v}</span>
        <span class="big" style="color:${convColor(f[2])}">${f[2].toFixed(1)}</span>
      </div></div></div>`;
  }).join("");
  const avg = sum / fws.length, ratio = (buys - avoids) / fws.length;
  let sig, col;
  if (ratio >= 0.5) { sig = "STRONG CONVERGENCE — BUY"; col = "var(--green)"; }
  else if (ratio >= 0.3) { sig = "MODERATE — LEAN BUY"; col = "var(--yellow)"; }
  else if (ratio <= -0.3) { sig = "DIVERGENT — AVOID"; col = "var(--red)"; }
  else if (avoids >= 3) { sig = "RED FLAGS"; col = "var(--red)"; }
  else { sig = "MIXED — NO EDGE"; col = "var(--muted)"; }

  $("an-verdict").textContent = sig; $("an-verdict").style.color = col;
  $("an-avg").textContent = avg.toFixed(2);
  $("an-list").innerHTML = rows;
  $("analyzer-result").classList.remove("hidden");
});

init();

# IIP Dashboard

A single static page (HTML/CSS/JS, no build step) that reads **only** from the Supabase
API (spec §7). Build §8 step 4 scope: **Candidates, Bitcoin, Analyzer** tabs. The rest
(Social, Trades, Portfolio, Scorecard, Settings) come in later steps.

## Files
- `index.html` — markup + styles (dark, large fonts, mobile + desktop, zoom enabled).
- `app.js` — Supabase client, magic-link auth, data loading, the 7-framework analyzer.
- `config.js` — Supabase URL + anon key. The anon key is **public-safe**: RLS locks all
  data to the authenticated owner, so the key alone returns nothing.

## Security model
RLS (`supabase/migrations/0003_enable_rls.sql`) allows data access only to the logged-in
owner (`dunkenproperties@gmail.com`). Login is **passwordless magic link**. The engine
writes via its service-role key, which bypasses RLS.

## What's verified
- Page + scripts are valid; the dashboard's queries return the live data (latest scan's
  conviction-sorted candidates; the Bitcoin snapshot with its signal breakdown).
- RLS confirmed: the anon key returns 0 rows until you log in.
- Analyzer logic is a verbatim port of the proven `frameworks()` from
  `IIP_Command_Center.html`.

## To actually use it (needs hosting + one Supabase setting)

Magic-link login requires the page to be served over http(s) (not opened as a file), and
the page's URL must be allow-listed in Supabase. Two one-time steps:

1. **Host this `docs/` folder.** Easiest is GitHub Pages:
   GitHub repo → Settings → Pages → Deploy from a branch → `main` + `/docs` folder.
   It serves at `https://dunkenproperties.github.io/investment-intelligence/`.
   (Publishing `/docs` exposes ONLY the dashboard; the rest of the private repo stays unpublished.)
2. **Allow that URL in Supabase Auth:** Supabase → Authentication → URL Configuration →
   set **Site URL** and add the page URL under **Redirect URLs**.

Then open the page, enter your email, click the link it sends, and you're in.

### Local testing alternative
Serve locally: `python -m http.server 5173` then open `http://localhost:5173/docs/`,
and add `http://localhost:5173` to the Supabase Redirect URLs list.

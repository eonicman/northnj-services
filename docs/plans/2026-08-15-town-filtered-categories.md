# Town-Filtered Category Pages — Implementation Plan

**Goal:** Let visitors filter a category (e.g. Plumbing) down to a specific town (e.g.
Wayne), as real server-rendered, indexable pages — without tripping the same AdSense
"low value content" flag that hit the JS-only DIY guide cards in August, and without
creating thin/near-duplicate pages for towns with too few listings.

**Architecture:** Extend the existing `renderCategoryPage()` pattern in `worker.js`
(already SSR: fetches the static HTML shell from `env.ASSETS`, queries D1 live, splices
rendered business cards into the `business-list` div). New route
`/category/{category}/{town-slug}.html` reuses the same shell + splice mechanism with
an added `town_slug` filter in the SQL, plus a one-line intro paragraph unique to that
town (avoids the page reading as a bare subset of the base category page). Pages are
only generated/linked for (town, category) pairs that clear a minimum listing count —
everything else has no route, no link, no sitemap entry, so it simply doesn't exist as
a crawlable page rather than existing as a thin one.

**Tech stack:** Cloudflare Workers + D1 (`directory-leads` DB, `businesses` table),
existing static HTML shells under `category/`.

**Threshold:** 2+ active businesses in that specific category+town combo (not town-wide
total — "Wayne has 34 listings" doesn't mean Wayne has 2+ plumbers specifically).

---

### Task 1: Add `town` and `town_slug` columns to `businesses`

**Objective:** Give the table a real, indexable town field instead of parsing it out
of `address` on every query.

**Files:** none (D1 schema change via `mcp__plugin_cloudflare_cloudflare-bindings__d1_database_query`, database_id `6e62cee1-81ba-4d35-917e-708087500877`)

**Step 1: Run migration**
```sql
ALTER TABLE businesses ADD COLUMN town TEXT;
ALTER TABLE businesses ADD COLUMN town_slug TEXT;
CREATE INDEX IF NOT EXISTS idx_businesses_town ON businesses(site, category, town_slug);
```

**Step 2: Verify**
```sql
PRAGMA table_info(businesses);
```
Expected: `town` and `town_slug` present, both nullable TEXT.

**Step 3: Commit**
No repo file changed — note the migration in `docs/plans/2026-08-15-town-filtered-categories.md` itself (this file) once run, with the date it was applied, since there's no migrations/ directory in this repo yet.

---

### Task 2: Backfill `town`/`town_slug` from existing `address`

**Objective:** Populate the new columns for all 161 existing northnj rows (and 141
mohawk rows, same table) using the same parse pattern already verified manually.

**Files:** none (D1 query)

**Step 1: Backfill town (raw text between first ", " and the next ",")**
```sql
UPDATE businesses
SET town = TRIM(SUBSTR(address, INSTR(address, ', ') + 2, INSTR(SUBSTR(address, INSTR(address, ', ') + 2), ',') - 1))
WHERE address LIKE '%, %,%' AND town IS NULL;
```

**Step 2: Backfill town_slug (lowercase, spaces/dots to hyphens)**
```sql
UPDATE businesses
SET town_slug = LOWER(REPLACE(REPLACE(TRIM(town), ' ', '-'), '.', ''))
WHERE town IS NOT NULL AND town_slug IS NULL;
```

**Step 3: Verify against the known-good manual count**
```sql
SELECT town, COUNT(*) FROM businesses WHERE site='northnjservices.com' AND town IS NOT NULL GROUP BY town ORDER BY COUNT(*) DESC LIMIT 5;
```
Expected: Wayne 34, Clifton 31, Paramus 12, Denville 9 (matches the manual query from
earlier today). If these don't match, stop — the parse regex needs fixing before
proceeding, don't paper over it with a WHERE clause exception.

**Step 4: Hand-fix the parse failures**
The manual query found 2 rows with empty address and 1 malformed row (`#2c`, a suite
number that broke the comma-split). Check and fix by hand:
```sql
SELECT id, name, address FROM businesses WHERE site='northnjservices.com' AND (town IS NULL OR town_slug = '' OR town LIKE '%#%');
```
Fix each with a direct `UPDATE businesses SET town=?, town_slug=? WHERE id=?` — there
should only be a handful across both sites.

---

### Task 3: Compute qualifying (town, category) pairs

**Objective:** Know exactly which town×category pages are worth creating before
writing any routing code — this list drives everything after it.

**Step 1: Run the report query**
```sql
SELECT town, town_slug, category, COUNT(*) as cnt
FROM businesses
WHERE site='northnjservices.com' AND status='active' AND town_slug IS NOT NULL
GROUP BY town_slug, category
HAVING cnt >= 2
ORDER BY town, category;
```

**Step 2: Save the output**
Paste the result into `docs/plans/2026-08-15-qualifying-town-categories.md` as a
plain list — this becomes the source of truth Task 5's route handler checks against
(or Task 5 can re-query live; either is fine, but the saved list is what a human
reviews before anything goes live).

**Step 3: Sanity-check the count**
Expect roughly 15-30 qualifying pairs given the density distribution (Wayne and
Clifton will dominate). If it's 100+, the threshold is too low — revisit before
building routes for a huge batch of borderline pages.

---

### Task 4: Add town-aware rendering to the worker

**Objective:** Extend `renderCategoryPage()` to accept an optional town filter and
render a unique intro line, without duplicating the whole function.

**Files:**
- Modify: `worker.js:275-303` (`renderCategoryPage`)
- Modify: `worker.js:48` (route matcher)

**Step 1: Widen the route matcher**
Current (`worker.js:48`):
```js
if (/^\/category\/(?!.*-diy)[a-z0-9-]+(\.html)?$/.test(p) && request.method === "GET") {
```
New:
```js
if (/^\/category\/(?!.*-diy)[a-z0-9-]+(\/[a-z0-9-]+)?(\.html)?$/.test(p) && request.method === "GET") {
```

**Step 2: Parse category + optional town from the path, reject non-qualifying towns**
In `renderCategoryPage`, replace the first two lines with:
```js
const parts = url.pathname.replace(/^\/category\//, "").replace(/\.html$/, "").split("/");
const category = parts[0];
const townSlug = parts[1] || null;

if (townSlug) {
  const qualifies = await env.LEADS.prepare(
    `SELECT COUNT(*) as cnt FROM businesses WHERE site=? AND category=? AND town_slug=? AND status='active'`
  ).bind(url.host, category, townSlug).first();
  if (!qualifies || qualifies.cnt < 2) return new Response("Not Found", { status: 404 });
}
```

**Step 3: Filter the D1 query by town when present**
Replace the existing query (`worker.js:292-296`) with:
```js
const rows = townSlug
  ? await env.LEADS.prepare(
      `SELECT name, category, phone, address, website, premium, rating, review_count FROM businesses
       WHERE site=? AND category=? AND town_slug=? AND status='active'
       ORDER BY premium DESC, sort_order ASC, name ASC`
    ).bind(url.host, category, townSlug).all()
  : await env.LEADS.prepare(
      `SELECT name, category, phone, address, website, premium, rating, review_count FROM businesses
       WHERE site=? AND category=? AND status='active'
       ORDER BY premium DESC, sort_order ASC, name ASC`
    ).bind(url.host, category).all();
```

**Step 4: Add a unique intro paragraph for town pages**
Right after computing `cards`, before building `rendered`:
```js
const townIntro = townSlug
  ? `<p style="margin-bottom:1rem;color:#555;">Looking for ${escapeHtml(category)} services in ${escapeHtml(rows.results[0]?.town || townSlug)}, NJ? Browse verified local businesses below.</p>`
  : "";
const rendered = PREMIUM_CSS + townIntro + startTag + "\n\n            " + cards + "\n    </div>";
```
(Reads the town display name off the first result row rather than re-deriving it from
the slug, so "Fair-Lawn" the slug renders as "Fair Lawn" the display text.)

**Step 5: Verify locally / via curl against the deployed worker**
```bash
curl -s "https://northnjservices.com/category/plumbing/wayne.html" | grep -c "biz-card"
```
Expected: a number >= 2, matching the D1 count for plumbing+wayne. Then:
```bash
curl -s -o /dev/null -w "%{http_code}" "https://northnjservices.com/category/plumbing/some-town-with-1-listing.html"
```
Expected: `404`.

**Step 6: Commit**
```bash
git add worker.js
git commit -m "feat: add town-filtered category pages, gated on 2+ listings per town+category"
```

---

### Task 5: Link qualifying town pages from the base category page

**Objective:** Make the new pages discoverable via real `<a>` tags (crawlable), not
just directly-typed URLs — a page with zero inbound links won't get indexed/valued
regardless of how well it's rendered.

**Files:** Modify: `worker.js` (`renderCategoryPage`, base/non-town case only)

**Step 1: Query qualifying towns for this category when rendering the base page**
```js
if (!townSlug) {
  const towns = await env.LEADS.prepare(
    `SELECT town, town_slug, COUNT(*) as cnt FROM businesses
     WHERE site=? AND category=? AND status='active' AND town_slug IS NOT NULL
     GROUP BY town_slug HAVING cnt >= 2 ORDER BY town`
  ).bind(url.host, category).all();
  if (towns.results?.length) {
    const links = towns.results.map(t =>
      `<a href="/category/${category}/${t.town_slug}.html" style="margin-right:.75rem;">${escapeHtml(t.town)}</a>`
    ).join("");
    townIntro_or_new_var = `<div style="margin-bottom:1rem;font-size:.9rem;">Browse by town: ${links}</div>`;
  }
}
```
(Fold this into the existing `rendered` string construction alongside `townIntro` from
Task 4 — same variable, just populated differently depending on whether `townSlug` is
set.)

**Step 2: Verify**
```bash
curl -s "https://northnjservices.com/category/plumbing.html" | grep -o 'category/plumbing/[a-z-]*\.html' | sort -u
```
Expected: matches the qualifying-towns list from Task 3 for the plumbing category.

**Step 3: Commit**
```bash
git add worker.js
git commit -m "feat: link qualifying town pages from base category pages"
```

---

### Task 6: Add qualifying URLs to sitemap.xml

**Objective:** Sitemap is currently a static file — add the new URLs so they're
discovered even before internal links get crawled.

**Files:** Modify: `sitemap.xml`

**Step 1: Generate entries from Task 3's saved list**
For each qualifying (town_slug, category) pair:
```xml
<url>
  <loc>https://northnjservices.com/category/{category}/{town_slug}.html</loc>
  <lastmod>2026-08-15</lastmod>
  <changefreq>monthly</changefreq>
  <priority>0.6</priority>
</url>
```

**Step 2: Verify well-formed XML**
```bash
xmllint --noout sitemap.xml && echo OK
```

**Step 3: Commit + push**
```bash
git add sitemap.xml
git commit -m "feat: add town-filtered category pages to sitemap"
git push origin main
```

---

### Task 7 (later phase, don't start until Task 1-6 are live and verified for ~1-2 weeks): Port to mohawk-valley-services

Same 6 tasks, same `businesses` table (already shared, `site='mohawkvalleyservices.com'`),
separate `worker.js` in that repo. Re-run Task 3's report query with
`site='mohawkvalleyservices.com'` first — Mohawk Valley's town distribution is
unknown and may not cluster the same way northnj does (34/31 for the top two towns);
don't assume the same threshold produces a similarly-sized qualifying list.

---

## Notes

- **Why gate at 2, not higher:** 2 is the minimum that isn't literally one business
  (which would read as an ad for that one business, not a directory). Revisit upward
  if any 2-listing page looks thin in practice once live — easy to raise the
  threshold and just stop linking/generating the pages that fall below it.
- **Why not generate-then-noindex instead of 404:** simpler mental model (a page
  either exists and is meant to be found, or it doesn't exist) and avoids the mistake
  of a `noindex` tag getting lost/removed later and quietly exposing a thin page.
- **Don't repeat the DIY-guide mistake:** every step above renders via the Worker
  before the response leaves Cloudflare — no step depends on client-side JS to
  produce the actual content. Confirm this holds by checking rendered HTML via
  `curl`, not a browser (curl sees exactly what a crawler sees).

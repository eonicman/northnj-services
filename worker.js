// Directory-site Worker: lead capture + DIY feature backend + static asset serving.
//   POST /lead                     -> store contact/Aria lead in D1 (leads)
//   POST /api/diy-request          -> return existing guide OR log a new request (diy_requests);
//                                      also captures the requester's email into `leads` (source=diy_guide_request)
//   POST /api/diy-request/update   -> attach email to a request (waitlist)
//   POST /api/diy-review           -> store a guide review (diy_reviews, pending moderation)
//   POST /api/diy-analytics/pageview -> store a pageview (diy_analytics)
//   GET  /api/diy-top?category=..  -> top requested projects for a category (live ranking)
//   GET  /api/diy-guides?category=..&limit=10 -> full guide content for the real top N in a
//                                      category, ranked by live request popularity (falls back
//                                      to curated order when a guide has zero requests yet)
//   POST /api/user/register        -> create a reader account (users), return session token
//   POST /api/user/login           -> verify password, return session token
//   GET  /api/user/me              -> current user + saved_guides (Bearer token)
//   POST /api/user/save-guide      -> save a guide to the signed-in user's library
//   GET  /                         -> static homepage, but with the #aria-video-embed block
//                                      rewritten to the ad video matching the visitor's
//                                      selected language (site_lang cookie)
//   everything else                -> static assets (env.ASSETS), unchanged
// D1 binding: env.LEADS -> database "directory-leads" (shared with mohawk-valley-services;
//   tables scoped by `site` = url.host, including users/user_sessions/saved_guides).

const SITE_HOST = "northnjservices.com";
const SITE_NAME = "North NJ Services";
const guideUrl = (cat, slug) => `https://northnjservices.com/category/${cat}-diy.html#${slug}`;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === "/lead") {
        return request.method === "POST"
          ? handleLead(request, env, url)
          : Response.redirect(url.origin + "/contact", 303);
      }
      if (p === "/api/diy-request" && request.method === "POST") return diyRequest(request, env, url);
      if (p === "/api/diy-request/update" && request.method === "POST") return diyRequestUpdate(request, env);
      if (p === "/api/diy-review" && request.method === "POST") return diyReview(request, env, url);
      if (p === "/api/diy-analytics/pageview" && request.method === "POST") return diyAnalytics(request, env, url);
      if (p === "/api/diy-top" && request.method === "GET") return diyTop(request, env, url);
      if (p === "/api/diy-guides" && request.method === "GET") return diyGuidesList(request, env, url);
      if (p === "/api/_feed" && request.method === "GET") return feed(request, env, url);
      if (p === "/api/admin/run-diy-fulfillment" && request.method === "POST") return runDiyFulfillmentEndpoint(request, env, url);
      if (p === "/api/premium-checkout" && request.method === "POST") return premiumCheckout(request, env, url);
      if (p === "/stripe-webhook" && request.method === "POST") return stripeWebhook(request, env);
      if (p === "/api/user/register" && request.method === "POST") return userRegister(request, env, url);
      if (p === "/api/user/login" && request.method === "POST") return userLogin(request, env, url);
      if (p === "/api/user/me" && request.method === "GET") return userMe(request, env, url);
      if (p === "/api/user/save-guide" && request.method === "POST") return userSaveGuide(request, env, url);
      if (/^\/category\/(?!.*-diy)[a-z0-9-]+(\/[a-z0-9-]+)?(\.html)?$/.test(p) && request.method === "GET") {
        return renderCategoryPage(request, env, url);
      }
      if (p === "/" && request.method === "GET") {
        return renderLangMatchedAd(request, env);
      }
    } catch (e) {
      return json({ status: "error", message: "server error" }, 500);
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(fulfillDiyRequests(env));
  },
};

/* ---------- helpers ---------- */
const S = (v, n) => (v == null ? "" : v.toString().slice(0, n));
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json; charset=utf-8" } });
const html = (body, status = 200) =>
  new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } });

async function readBody(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await request.json();
  const form = await request.formData();
  const o = {};
  for (const [k, v] of form.entries()) o[k] = typeof v === "string" ? v : (v && v.name) || "";
  return o;
}
function slugify(s) {
  return S(s, 120).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}
function categoryFrom(page, fallback) {
  const m = /\/category\/([^/.?#]+)/i.exec(page || "");
  return m ? m[1].toLowerCase() : S(fallback || "unknown", 60);
}
const meta = (request) => ({
  ua: S(request.headers.get("user-agent"), 400),
  ip: request.headers.get("cf-connecting-ip") || "",
});

/* ---------- lead capture (contact + Aria forms) ---------- */
async function handleLead(request, env, url) {
  try {
    const data = await readBody(request);
    if (S(data._gotcha, 10).trim() !== "") return html(thankYouPage(url.host, ""));
    const business = S(data.business || data.business_name, 200);
    const name = S(data.name || data.contact_name, 200);
    const phone = S(data.phone, 60);
    const email = S(data.email, 200);
    const interest = S(data.interest || data.business_type, 200);
    const message = S(data.message || data.notes, 4000);
    const source = S(data.source || url.host, 300);
    if (!email && !phone) return html(errorPage(url.host), 400);
    const m = meta(request);
    await env.LEADS.prepare(
      `INSERT INTO leads (site, source, business, name, phone, email, interest, message, raw_json, ua, ip, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now'))`
    ).bind(url.host, source, business, name, phone, email, interest, message,
           JSON.stringify(data).slice(0, 8000), m.ua, m.ip).run();
    return html(thankYouPage(url.host, name));
  } catch (e) {
    return html(errorPage(url.host), 500);
  }
}

/* ---------- DIY: request a guide ---------- */
async function diyRequest(request, env, url) {
  const data = await readBody(request);
  const project = S(data.project, 300);
  if (!project) return json({ status: "error", message: "project required" }, 400);
  const category = categoryFrom(data.page, data.category);
  const slug = slugify(project);
  const m = meta(request);

  const email = S(data.email, 200);

  // A request with an email is a real subscriber signal, whether or not the
  // guide already exists in the library -- capture it into `leads` too so
  // guide requests count as a lead-gen source, not just DIY plumbing.
  if (email) {
    await env.LEADS.prepare(
      `INSERT INTO leads (site, source, business, name, phone, email, interest, message, raw_json, ua, ip, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now'))`
    ).bind(url.host, "diy_guide_request", "", "", "", email, `${category}: ${project}`,
           S(data.details, 2000), JSON.stringify(data).slice(0, 8000), m.ua, m.ip).run();
  }

  // 1) library hit? return the published guide instantly (full content).
  const g = await env.LEADS.prepare(
    `SELECT * FROM diy_guides WHERE site=? AND category=? AND slug=? AND status='published' LIMIT 1`
  ).bind(url.host, category, slug).first();
  if (g) {
    return json({ status: "existing", guide: guideRow(g) });
  }

  // 2) new request -> log it, return request_id for the email step.
  const res = await env.LEADS.prepare(
    `INSERT INTO diy_requests (site, category, project, skill, details, email, page, ua, ip, created_at)
     VALUES (?,?,?,?,?,?,?,?,?, datetime('now'))`
  ).bind(url.host, category, project, S(data.skill, 60), S(data.details, 2000),
         email, S(data.page, 400), m.ua, m.ip).run();
  return json({ status: "new", request_id: res.meta.last_row_id });
}

async function diyRequestUpdate(request, env) {
  const data = await readBody(request);
  const id = parseInt(data.request_id, 10);
  const email = S(data.email, 200);
  if (id && email) {
    await env.LEADS.prepare(`UPDATE diy_requests SET email=? WHERE id=?`).bind(email, id).run();
  }
  return json({ status: "ok" });
}

async function diyReview(request, env, url) {
  const data = await readBody(request);
  await env.LEADS.prepare(
    `INSERT INTO diy_reviews (site, name, town, guide, rating, review, featured, approved, created_at)
     VALUES (?,?,?,?,?,?,?,0, datetime('now'))`
  ).bind(url.host, S(data.name, 120), S(data.town, 120), S(data.guide, 200),
         parseInt(data.rating, 10) || 0, S(data.review, 4000), data.featured ? 1 : 0).run();
  return json({ status: "ok" });
}

async function diyAnalytics(request, env, url) {
  const data = await readBody(request);
  const m = meta(request);
  await env.LEADS.prepare(
    `INSERT INTO diy_analytics (site, url, path, category, screen, referrer, ua, ip, created_at)
     VALUES (?,?,?,?,?,?,?,?, datetime('now'))`
  ).bind(url.host, S(data.url, 400), S(data.path, 200), S(data.category, 120),
         S(data.screenSize, 40), S(data.referrer, 400), m.ua, m.ip).run();
  return new Response(null, { status: 204 });
}

async function diyTop(request, env, url) {
  const category = S(url.searchParams.get("category"), 60).toLowerCase();
  const limit = Math.min(parseInt(url.searchParams.get("limit"), 10) || 10, 25);
  const q = category
    ? env.LEADS.prepare(
        `SELECT project, COUNT(*) AS n FROM diy_requests WHERE site=? AND category=?
         GROUP BY lower(project) ORDER BY n DESC LIMIT ?`).bind(url.host, category, limit)
    : env.LEADS.prepare(
        `SELECT project, COUNT(*) AS n FROM diy_requests WHERE site=?
         GROUP BY lower(project) ORDER BY n DESC LIMIT ?`).bind(url.host, limit);
  const rows = await q.all();
  return json({ status: "ok", category, top: (rows.results || []).map(r => ({ project: r.project, count: r.n })) });
}

function guideRow(g) {
  let tools = [], steps = [];
  try { tools = JSON.parse(g.tools_json || "[]"); } catch (e) {}
  try { steps = JSON.parse(g.steps_json || "[]"); } catch (e) {}
  return {
    project: g.project, slug: g.slug, difficulty: g.difficulty,
    time_est: g.time_est, cost_est: g.cost_est,
    icon_emoji: g.icon_emoji, icon_bg: g.icon_bg,
    description: g.description, tools, steps,
    shop_link: g.shop_link, shop_label: g.shop_label,
    warning_html: g.warning_html, tip_html: g.tip_html,
    request_count: g.request_count || 0,
  };
}

/* ---------- business listings: dynamic category-page rendering ---------- */
function escapeHtml(s) {
  return S(s, 2000).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function bizCardHtml(b) {
  const cls = b.premium ? "biz-card premium" : "biz-card";
  const badge = b.premium ? `<div class="premium-badge">★ Featured</div>` : "";
  const phone = b.phone
    ? `<span itemprop="telephone" style="display:block;margin:.2rem 0;">&#9742; ${escapeHtml(b.phone)}</span>`
    : "";
  const address = b.address
    ? `<span itemprop="address" style="display:block;margin:.2rem 0;">\u{1F4CD} ${escapeHtml(b.address)}</span>`
    : "";
  const rating = b.rating
    ? `<div style="display:flex;align-items:center;gap:.4rem;margin-top:.35rem;">
                <span style="color:#f59e0b;font-size:.9rem;letter-spacing:1px;">${starString(b.rating)}</span>
                <span style="font-size:.78rem;color:#888;">${b.rating} (${b.review_count || 0} reviews)</span>
              </div>`
    : "";
  const website = b.website
    ? `<div style="margin-top:.4rem;"><a href="${escapeHtml(b.website)}" target="_blank" rel="noopener sponsored" style="color:#0f3460;text-decoration:none;font-size:.85rem;font-weight:500;">\u{1F310} ${escapeHtml(b.website.replace(/^https?:\/\//, "").replace(/\/$/, ""))}</a></div>`
    : "";
  return `<div class="${cls}" itemscope itemtype="https://schema.org/LocalBusiness">
${badge}              <h3 itemprop="name">${escapeHtml(b.name)}</h3>
              <div class="biz-cat">${escapeHtml(b.category)}</div>
              <div class="biz-info">
                ${phone}
                ${address}
              </div>
              ${rating}
              ${website}
            </div>`;
}

function starString(rating) {
  const full = Math.floor(rating);
  const half = rating - full >= 0.5;
  return "★".repeat(full) + (half ? "½" : "") + "☆".repeat(Math.max(0, 5 - full - (half ? 1 : 0)));
}

const PREMIUM_CSS = `<style>.biz-card.premium{border-left-color:#d4af37!important;box-shadow:0 2px 10px rgba(212,175,55,.25);position:relative}.premium-badge{display:inline-block;background:#d4af37;color:#1a1a2e;font-size:.7rem;font-weight:700;padding:.15rem .5rem;border-radius:10px;margin-bottom:.4rem}</style>`;

// Finds the end of a <div class="business-list">...</div> block by depth-counting,
// since it nests other <div>s (biz-card, website-link) that a naive regex would mis-match.
function findDivBlockEnd(html, startIdx) {
  let depth = 0, pos = startIdx;
  while (pos < html.length) {
    const nextOpen = html.indexOf("<div", pos);
    const nextClose = html.indexOf("</div>", pos);
    if (nextClose === -1) return -1;
    if (nextOpen !== -1 && nextOpen < nextClose) {
      depth++;
      pos = nextOpen + 4;
    } else {
      depth--;
      pos = nextClose + 6;
      if (depth === 0) return pos;
    }
  }
  return -1;
}

// Language -> Aria ad video variant. "en" is the original YouTube embed already in the
// static HTML, so it needs no rewrite. Every other language is a self-hosted mp4 (no
// per-language YouTube upload/metadata to manage) served from env.ASSETS at the path
// below -- drop a new file there and add one line here to add a language.
const ARIA_AD_VIDEO = {
  es: "/assets/media/aria-es.mp4",
};

function pickAdLang(request) {
  const cookie = request.headers.get("Cookie") || "";
  const m = cookie.match(/(?:^|;\s*)site_lang=([a-z]{2})/);
  return m && ARIA_AD_VIDEO[m[1]] ? m[1] : "en";
}

async function renderLangMatchedAd(request, env) {
  const resp = await env.ASSETS.fetch(request);
  if (!resp.ok || !(resp.headers.get("content-type") || "").includes("text/html")) return resp;

  const lang = pickAdLang(request);
  if (lang === "en") return resp; // static HTML already has the English YouTube embed

  const html = await resp.text();
  const startTag = '<div id="aria-video-embed"';
  const startIdx = html.indexOf(startTag);
  if (startIdx === -1) return new Response(html, { status: resp.status, headers: resp.headers });
  const tagEnd = html.indexOf(">", startIdx);
  const endIdx = findDivBlockEnd(html, startIdx);
  if (tagEnd === -1 || endIdx === -1) return new Response(html, { status: resp.status, headers: resp.headers });

  const src = ARIA_AD_VIDEO[lang];
  const replacement =
    html.slice(startIdx, tagEnd + 1) +
    `<video width="100%" height="100%" style="object-fit:cover" src="${src}" controls playsinline preload="metadata"></video>` +
    "</div>";
  const out = html.slice(0, startIdx) + replacement + html.slice(endIdx);
  return new Response(out, { status: resp.status, headers: resp.headers });
}

async function renderCategoryPage(request, env, url) {
  const parts = url.pathname.replace(/^\/category\//, "").replace(/\.html$/, "").split("/");
  const category = parts[0];
  const townSlug = parts[1] || null;

  if (townSlug) {
    const qualifies = await env.LEADS.prepare(
      `SELECT COUNT(*) as cnt FROM businesses WHERE site=? AND category=? AND town_slug=? AND status='active'`
    ).bind(url.host, category, townSlug).first();
    if (!qualifies || qualifies.cnt < 2) return new Response("Not Found", { status: 404 });
  }

  // Fetch the canonical extensionless path -- asking ASSETS for the `.html` form gets a 307
  // (Cloudflare's default html_handling normalizes to extensionless), which would otherwise
  // short-circuit this function before the D1 rendering ever runs. Town pages reuse the base
  // category shell (no separate static file per town) -- only the category segment maps to a
  // real asset path.
  const assetUrl = new URL(url);
  assetUrl.pathname = `/category/${category}`;
  const resp = await env.ASSETS.fetch(new Request(assetUrl, request));
  if (!resp.ok) return resp;
  const html = await resp.text();

  const startTag = '<div class="business-list">';
  const startIdx = html.indexOf(startTag);
  if (startIdx === -1) return new Response(html, { status: resp.status, headers: resp.headers });
  const endIdx = findDivBlockEnd(html, startIdx);
  if (endIdx === -1) return new Response(html, { status: resp.status, headers: resp.headers });

  const rows = townSlug
    ? await env.LEADS.prepare(
        `SELECT name, category, phone, address, website, premium, rating, review_count, town FROM businesses
         WHERE site=? AND category=? AND town_slug=? AND status='active'
         ORDER BY premium DESC, sort_order ASC, name ASC`
      ).bind(url.host, category, townSlug).all()
    : await env.LEADS.prepare(
        `SELECT name, category, phone, address, website, premium, rating, review_count FROM businesses
         WHERE site=? AND category=? AND status='active'
         ORDER BY premium DESC, sort_order ASC, name ASC`
      ).bind(url.host, category).all();

  const cards = (rows.results || []).map(bizCardHtml).join("\n            ");

  let introHtml = "";
  if (townSlug) {
    const townName = rows.results?.[0]?.town || townSlug;
    introHtml = `<p style="margin-bottom:1rem;color:#555;">Looking for ${escapeHtml(category)} services in ${escapeHtml(townName)}, NJ? Browse verified local businesses below.</p>`;
  } else {
    const towns = await env.LEADS.prepare(
      `SELECT town, town_slug, COUNT(*) as cnt FROM businesses
       WHERE site=? AND category=? AND status='active' AND town_slug IS NOT NULL
       GROUP BY town_slug HAVING cnt >= 2 ORDER BY town`
    ).bind(url.host, category).all();
    if (towns.results?.length) {
      const links = towns.results.map(t =>
        `<a href="/category/${category}/${t.town_slug}.html" style="margin-right:.75rem;">${escapeHtml(t.town)}</a>`
      ).join("");
      introHtml = `<div style="margin-bottom:1rem;font-size:.9rem;">Browse by town: ${links}</div>`;
    }
  }

  const rendered = PREMIUM_CSS + introHtml + startTag + "\n\n            " + cards + "\n    </div>";
  const newHtml = html.slice(0, startIdx) + rendered + html.slice(endIdx);

  return new Response(newHtml, { status: resp.status, headers: resp.headers });
}

/* ---------- premium listings: checkout + Stripe webhook ---------- */
async function premiumCheckout(request, env, url) {
  const data = await readBody(request);
  const business = S(data.business, 200).trim();
  const category = S(data.category, 60).toLowerCase().trim();
  const phone = S(data.phone, 60);
  const email = S(data.email, 200);
  const plan = data.plan === "annual" ? "annual" : "monthly";
  if (!business || !category || !email) return json({ status: "error", message: "business, category, and email are required" }, 400);

  const priceId = plan === "annual" ? env.STRIPE_PRICE_ANNUAL : env.STRIPE_PRICE_MONTHLY;
  if (!priceId || !env.STRIPE_SECRET_KEY) return json({ status: "error", message: "checkout not configured" }, 500);

  const slug = slugify(business);
  await env.LEADS.prepare(
    `INSERT INTO businesses (site, category, slug, name, phone, email, sort_order)
     VALUES (?,?,?,?,?,?, 9999)
     ON CONFLICT(site, category, slug) DO UPDATE SET phone=excluded.phone, email=excluded.email, updated_at=datetime('now')`
  ).bind(url.host, category, slug, business, phone, email).run();

  const row = await env.LEADS.prepare(
    `SELECT id FROM businesses WHERE site=? AND category=? AND slug=?`
  ).bind(url.host, category, slug).first();
  if (!row) return json({ status: "error", message: "could not create listing" }, 500);

  const form = new URLSearchParams({
    mode: "subscription",
    "line_items[0][price]": priceId,
    "line_items[0][quantity]": "1",
    client_reference_id: String(row.id),
    customer_email: email,
    success_url: `${url.origin}/premium-success.html?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${url.origin}/premium.html`,
    "metadata[business_id]": String(row.id),
    "metadata[site]": url.host,
    "metadata[category]": category,
    "metadata[plan]": plan,
  });

  const stripeResp = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  const session = await stripeResp.json();
  if (!stripeResp.ok) return json({ status: "error", message: session.error?.message || "stripe error" }, 502);

  return json({ status: "ok", url: session.url });
}

async function verifyStripeSignature(rawBody, sigHeader, secret) {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(sigHeader.split(",").map((p) => p.split("=")));
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // reject stale (>5min) to avoid replay

  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${rawBody}`));
  const digest = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return digest === v1;
}

async function stripeWebhook(request, env) {
  const rawBody = await request.text();
  const ok = await verifyStripeSignature(rawBody, request.headers.get("Stripe-Signature"), env.STRIPE_WEBHOOK_SECRET);
  if (!ok) return new Response("invalid signature", { status: 400 });

  const event = JSON.parse(rawBody);
  const obj = event.data?.object || {};

  if (event.type === "checkout.session.completed") {
    const businessId = parseInt(obj.client_reference_id, 10);
    if (businessId) {
      const plan = obj.metadata?.plan === "annual" ? "annual" : "monthly";
      await env.LEADS.prepare(
        `UPDATE businesses SET premium=1, premium_plan=?, status='active',
         stripe_customer_id=?, stripe_subscription_id=?, updated_at=datetime('now') WHERE id=?`
      ).bind(plan, S(obj.customer, 200), S(obj.subscription, 200), businessId).run();
      const biz = await env.LEADS.prepare(`SELECT site, name, email FROM businesses WHERE id=?`).bind(businessId).first();
      if (biz) {
        await env.LEADS.prepare(
          `INSERT INTO leads (site, source, business, email, interest, message, created_at)
           VALUES (?,?,?,?,'premium-activated',?, datetime('now'))`
        ).bind(biz.site, "stripe-webhook", biz.name, biz.email, `Premium ${plan} activated`).run();
      }
    }
  } else if (event.type === "customer.subscription.deleted") {
    const subId = S(obj.id, 200);
    const biz = await env.LEADS.prepare(`SELECT id, site, name, email FROM businesses WHERE stripe_subscription_id=?`).bind(subId).first();
    if (biz) {
      await env.LEADS.prepare(`UPDATE businesses SET premium=0, status='canceled', updated_at=datetime('now') WHERE id=?`).bind(biz.id).run();
      await env.LEADS.prepare(
        `INSERT INTO leads (site, source, business, email, interest, message, created_at)
         VALUES (?,?,?,?,'premium-canceled',?, datetime('now'))`
      ).bind(biz.site, "stripe-webhook", biz.name, biz.email, "Subscription ended").run();
    }
  }

  return json({ status: "ok" });
}

/* ---------- DIY: dynamic top-N guides (with full content) for a category ---------- */
async function diyGuidesList(request, env, url) {
  const category = S(url.searchParams.get("category"), 60).toLowerCase();
  const limit = Math.min(parseInt(url.searchParams.get("limit"), 10) || 10, 25);
  if (!category) return json({ status: "error", message: "category required" }, 400);
  const rows = await env.LEADS.prepare(
    `SELECT g.*, COALESCE(r.n, 0) AS request_count
     FROM diy_guides g
     LEFT JOIN (
       SELECT lower(project) AS proj, category, COUNT(*) AS n
       FROM diy_requests WHERE site=? GROUP BY lower(project), category
     ) r ON r.proj = lower(g.project) AND r.category = g.category
     WHERE g.site=? AND g.category=? AND g.status='published'
     ORDER BY request_count DESC, g.id ASC
     LIMIT ?`
  ).bind(url.host, url.host, category, limit).all();
  return json({ status: "ok", category, guides: (rows.results || []).map(guideRow) });
}

/* ---------- DIY: guide-request fulfillment (Cron Trigger, every 15 min) ----------
   Emails the requester when a matching published guide exists in diy_guides.
   If no guide exists yet, the request is left unfulfilled -- Ghost generates
   missing guides via Vaaya and publishes them; the next scheduled run then
   finds the library hit and sends. */
async function fulfillDiyRequests(env) {
  const pending = await env.LEADS.prepare(
    `SELECT id, category, project, email FROM diy_requests
     WHERE site=? AND fulfilled_at IS NULL AND email IS NOT NULL AND email != ''
     ORDER BY created_at ASC LIMIT 5`
  ).bind(SITE_HOST).all();

  let sent = 0, skipped = 0;
  for (const req of pending.results || []) {
    const slug = slugify(req.project);
    const g = await env.LEADS.prepare(
      `SELECT * FROM diy_guides WHERE site=? AND category=? AND slug=? AND status='published' LIMIT 1`
    ).bind(SITE_HOST, req.category, slug).first();
    if (!g) { skipped++; continue; }

    const guide = guideRow(g);
    const ok = await sendGuideEmail(env, req.email, guide, guideUrl(req.category, slug));
    if (ok) {
      await env.LEADS.prepare(`UPDATE diy_requests SET fulfilled_at = datetime('now') WHERE id=?`).bind(req.id).run();
      sent++;
    }
  }
  return { sent, skipped };
}

async function sendGuideEmail(env, to, guide, url) {
  if (!env.RESEND_API_KEY) return false;
  const toolsHtml = (guide.tools || []).map((t) => `<li><a href="${t.url}">${t.emoji || ""} ${t.label}</a></li>`).join("");
  const stepsHtml = (guide.steps || []).map((s) => `<li><strong>${s.title}</strong> ${s.detail}</li>`).join("");
  const emailHtml = `
    <h2>${guide.project}</h2>
    <p>${guide.description}</p>
    <p><strong>Difficulty:</strong> ${guide.difficulty} &nbsp; <strong>Time:</strong> ${guide.time_est} &nbsp; <strong>Cost:</strong> ${guide.cost_est}</p>
    <h3>Tools needed</h3><ul>${toolsHtml}</ul>
    <h3>Steps</h3><ol>${stepsHtml}</ol>
    <p>${guide.warning_html || ""}</p>
    <p>${guide.tip_html || ""}</p>
    <p><a href="${url}">See the full formatted guide online &rarr;</a></p>
    <p>Thanks for using ${SITE_NAME}!</p>
  `;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: `${SITE_NAME} <guides@eonic.cloud>`,
      to,
      subject: `Your DIY guide: ${guide.project}`,
      html: emailHtml,
    }),
  });
  return res.ok;
}

/* manual/testing trigger for the same job the Cron runs, gated by the existing feed key */
async function runDiyFulfillmentEndpoint(request, env, url) {
  const key = url.searchParams.get("key") || "";
  if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) return new Response("Not found", { status: 404 });
  const result = await fulfillDiyRequests(env);
  return json({ status: "ok", ...result });
}

/* ---------- internal feed (token-gated) for the NightShift lead-monitor ---------- */
async function feed(request, env, url) {
  const key = url.searchParams.get("key") || "";
  if (!env.FEED_KEY || key !== env.FEED_KEY) return new Response("Not found", { status: 404 });
  const al = parseInt(url.searchParams.get("after_lead"), 10) || 0;
  const ad = parseInt(url.searchParams.get("after_diy"), 10) || 0;
  const leads = await env.LEADS.prepare(
    `SELECT id, site, source, business, name, phone, email, interest, message, created_at
     FROM leads WHERE id > ? AND site = ? ORDER BY id LIMIT 50`).bind(al, url.host).all();
  const diy = await env.LEADS.prepare(
    `SELECT id, site, category, project, email, created_at
     FROM diy_requests WHERE id > ? AND site = ? ORDER BY id LIMIT 50`).bind(ad, url.host).all();
  return json({ status: "ok", leads: leads.results || [], diy: diy.results || [] });
}

/* ---------- reader accounts (diy-auth.js: register/login/me/save-guide) ---------- */
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100000;

function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
function randomHex(numBytes) {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(numBytes)));
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function hashPassword(password, saltHex) {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    keyMaterial,
    256
  );
  return { hash: bytesToHex(new Uint8Array(bits)), salt: bytesToHex(salt) };
}
async function createSession(env, userId) {
  const token = randomHex(32);
  const expires = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();
  await env.LEADS.prepare(`INSERT INTO user_sessions (token, user_id, expires_at) VALUES (?,?,?)`)
    .bind(token, userId, expires).run();
  return token;
}
async function userFromRequest(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+(.+)$/.exec(auth);
  if (!m) return null;
  const row = await env.LEADS.prepare(
    `SELECT u.id, u.name, u.email FROM user_sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token = ? AND s.expires_at > datetime('now')`
  ).bind(m[1]).first();
  return row || null;
}

async function userRegister(request, env, url) {
  const data = await readBody(request);
  const email = S(data.email, 200).trim().toLowerCase();
  const password = S(data.password, 200);
  const name = S(data.name, 120);
  if (!email || !password || password.length < 6) {
    return json({ error: "Email and a password of at least 6 characters are required" }, 400);
  }
  const existing = await env.LEADS.prepare(`SELECT id FROM users WHERE site=? AND email=?`)
    .bind(url.host, email).first();
  if (existing) return json({ error: "An account with that email already exists" }, 409);
  const { hash, salt } = await hashPassword(password);
  const res = await env.LEADS.prepare(
    `INSERT INTO users (site, email, name, password_hash, password_salt) VALUES (?,?,?,?,?)`
  ).bind(url.host, email, name, hash, salt).run();
  const userId = res.meta.last_row_id;
  const token = await createSession(env, userId);
  return json({ token, user: { id: userId, name, email } });
}

async function userLogin(request, env, url) {
  const data = await readBody(request);
  const email = S(data.email, 200).trim().toLowerCase();
  const password = S(data.password, 200);
  const user = await env.LEADS.prepare(`SELECT id, name, email, password_hash, password_salt FROM users WHERE site=? AND email=?`)
    .bind(url.host, email).first();
  if (!user) return json({ error: "Invalid email or password" }, 401);
  const { hash } = await hashPassword(password, user.password_salt);
  if (!timingSafeEqual(hash, user.password_hash)) return json({ error: "Invalid email or password" }, 401);
  const token = await createSession(env, user.id);
  return json({ token, user: { id: user.id, name: user.name, email: user.email } });
}

async function userMe(request, env, url) {
  const user = await userFromRequest(request, env);
  if (!user) return json({ error: "Not signed in" }, 401);
  const guides = await env.LEADS.prepare(
    `SELECT guide_id, category, guide_title FROM saved_guides WHERE user_id=? ORDER BY created_at DESC`
  ).bind(user.id).all();
  return json({ user: { ...user, saved_guides: guides.results || [] } });
}

async function userSaveGuide(request, env, url) {
  const user = await userFromRequest(request, env);
  if (!user) return json({ error: "Not signed in" }, 401);
  const data = await readBody(request);
  const guideId = S(data.guideId, 200);
  if (!guideId) return json({ error: "guideId required" }, 400);
  await env.LEADS.prepare(
    `INSERT OR IGNORE INTO saved_guides (user_id, guide_id, category, guide_title) VALUES (?,?,?,?)`
  ).bind(user.id, guideId, S(data.category, 120), S(data.guideTitle, 300)).run();
  return json({ success: true });
}

/* ---------- shared HTML pages (lead thank-you) ---------- */
function page(host, title, inner) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:#0f0f1a;color:#f2f2f2;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:2rem}
.card{max-width:540px;text-align:center;background:#1a1a2e;border:1px solid #2a2a44;border-radius:14px;padding:2.5rem}
h1{color:#e94560;margin:0 0 .75rem}a{color:#4ecdc4}</style></head>
<body><div class="card">${inner}<p style="margin-top:1.5rem"><a href="https://${host}/">&larr; Back to ${host}</a></p></div></body></html>`;
}
function thankYouPage(host, name) {
  const who = name ? `, ${name}` : "";
  return page(host, "Thanks — we got it",
    `<h1>Thank you${who}!</h1><p>Your message is in — we'll be in touch shortly. If it's urgent, call <a href="tel:8552724773">(855) 272-4773</a>.</p>`);
}
function errorPage(host) {
  return page(host, "Something went wrong",
    `<h1>Hmm, that didn't send</h1><p>Please try again, or reach us directly at <a href="tel:8552724773">(855) 272-4773</a>.</p>`);
}

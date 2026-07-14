// Directory-site Worker: lead capture + static asset serving.
//   POST /lead  -> validate + store submission in D1 (LEADS), return a thank-you page.
//   everything else -> served from static assets (env.ASSETS).
// Static pages are unchanged; only form POSTs reach this code.

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/lead") {
      if (request.method !== "POST") {
        return Response.redirect(url.origin + "/contact", 303);
      }
      return handleLead(request, env, url);
    }
    return env.ASSETS.fetch(request);
  },
};

async function handleLead(request, env, url) {
  try {
    const ct = request.headers.get("content-type") || "";
    let data = {};
    if (ct.includes("application/json")) {
      data = await request.json();
    } else {
      const form = await request.formData();
      for (const [k, v] of form.entries()) {
        data[k] = typeof v === "string" ? v : (v && v.name) || "";
      }
    }

    // simple bot honeypot: real users never fill a field named _gotcha
    if ((data._gotcha || "").toString().trim() !== "") {
      return htmlResponse(thankYouPage(url.host, ""));
    }

    const s = (v, n) => (v == null ? "" : v.toString().slice(0, n));
    const business = s(data.business || data.business_name, 200);
    const name = s(data.name || data.contact_name, 200);
    const phone = s(data.phone, 60);
    const email = s(data.email, 200);
    const interest = s(data.interest || data.business_type, 200);
    const message = s(data.message || data.notes, 4000);
    const source = s(data.source || url.host, 300);

    if (!email && !phone) {
      return htmlResponse(errorPage(url.host), 400);
    }

    await env.LEADS.prepare(
      `INSERT INTO leads (site, source, business, name, phone, email, interest, message, raw_json, ua, ip, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?, datetime('now'))`
    ).bind(
      url.host, source, business, name, phone, email, interest, message,
      JSON.stringify(data).slice(0, 8000),
      s(request.headers.get("user-agent"), 400),
      request.headers.get("cf-connecting-ip") || ""
    ).run();

    return htmlResponse(thankYouPage(url.host, name));
  } catch (e) {
    return htmlResponse(errorPage(url.host), 500);
  }
}

function htmlResponse(html, status = 200) {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

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

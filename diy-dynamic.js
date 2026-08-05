// Dynamic DIY guide grid: fetches the real top-N guides for this category from
// /api/diy-guides and renders them into #diy-grid, replacing the old static HTML.
// Also implements toggleSteps() and filterDIY(), which the page markup already
// calls but which were never actually defined anywhere (dead onclick handlers).

function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function renderTool(t) {
  return `<span class="diy-tool">${t.emoji || ""} <a href="${t.url}" target="_blank" rel="nofollow sponsored">${escapeHtml(t.label)}</a></span>`;
}

function renderStep(s, i) {
  const icon = s.icon_svg && s.icon_svg.trim().startsWith("<svg")
    ? s.icon_svg
    : `<span style="font-size:24px;">${s.icon_svg || "🔧"}</span>`;
  return `
    <div class="step-row" style="display:flex;align-items:flex-start;gap:.75rem;padding:.5rem 0;border-bottom:1px solid #f0f0f0;">
      <div class="step-icon-box" style="width:50px;height:50px;min-width:50px;background:#f8f9fa;border-radius:8px;display:flex;align-items:center;justify-content:center;border:1px solid #e0e0e0;">${icon}</div>
      <div class="step-text" style="flex:1;">
        <div style="font-size:.72rem;color:#e94560;font-weight:700;margin-bottom:.15rem;text-transform:uppercase;letter-spacing:.5px;">${escapeHtml(s.label || `Step ${i + 1}`)}</div>
        <strong style="color:#1a1a2e;font-size:.88rem;display:block;margin-bottom:.1rem;line-height:1.3;">${escapeHtml(s.title)}</strong>
        <span style="color:#888;font-size:.8rem;line-height:1.4;">${escapeHtml(s.detail)}</span>
      </div>
    </div>`;
}

function renderCard(g) {
  const tools = (g.tools || []).map(renderTool).join("");
  const hasSteps = (g.steps || []).length > 0;
  const steps = (g.steps || []).map(renderStep).join("");
  return `
    <div class="diy-card" data-difficulty="${g.difficulty || "easy"}" data-slug="${g.slug}">
      <div class="diy-card-header">
        <div class="diy-icon" style="background:${g.icon_bg || "#f0f0f0"};">${g.icon_emoji || "🔧"}</div>
        <div>
          <h3>${escapeHtml(g.project)}</h3>
          <div class="diy-meta">
            <span class="diy-difficulty ${g.difficulty || "easy"}" style="color:${g.difficulty === "hard" ? "#ef4444" : g.difficulty === "medium" ? "#f59e0b" : "#22c55e"}">● ${(g.difficulty || "easy").charAt(0).toUpperCase() + (g.difficulty || "easy").slice(1)}</span>
            <span>⏱️ ${escapeHtml(g.time_est)}</span>
            <span>💰 ${escapeHtml(g.cost_est)}</span>
          </div>
        </div>
        <span class="expand-icon">▼</span>
      </div>
      <div class="diy-card-body">
        <p>${escapeHtml(g.description)}</p>
        <div class="diy-tools">
          <h4>🛠️ Tools Needed</h4>
          <div class="diy-tool-list">${tools}</div>
        </div>
        <div class="diy-actions">
          <button class="diy-btn diy-btn-primary" onclick="toggleSteps(this)">📖 View Steps</button>
          ${g.shop_link ? `<a href="${g.shop_link}" class="diy-btn diy-btn-secondary" target="_blank" rel="nofollow sponsored">${escapeHtml(g.shop_label || "🛒 Shop")}</a>` : ""}
        </div>
      </div>
      <div class="diy-expand">
        <div class="diy-steps">
          ${g.warning_html ? `<div class="warning">${g.warning_html}</div>` : ""}
          ${hasSteps ? steps : `<p style="color:#888;font-size:.85rem;padding:.5rem 0;">Step-by-step instructions for this one are still being written — check back soon, or use "Request a Guide" below for a version emailed to you.</p>`}
          ${g.tip_html ? `<p style="margin-top:.75rem;font-size:.82rem;color:#888;">${g.tip_html}</p>` : ""}
        </div>
      </div>
    </div>`;
}

// toggleSteps: the "View Steps" button inside a card. Whole-card click (see
// per-page DOMContentLoaded handler) already expands/collapses via .collapsed,
// so this just delegates to the same mechanism from the button specifically.
function toggleSteps(btn) {
  const card = btn.closest(".diy-card");
  if (!card) return;
  const isCollapsed = card.classList.contains("collapsed");
  document.querySelectorAll(".diy-card:not(.collapsed)").forEach((c) => {
    if (c !== card) c.classList.add("collapsed");
  });
  card.classList.toggle("collapsed", !isCollapsed);
}

function filterDIY(level) {
  document.querySelectorAll(".diy-filter button").forEach((b) => b.classList.remove("active"));
  const btn = Array.from(document.querySelectorAll(".diy-filter button"))
    .find((b) => b.getAttribute("onclick") === `filterDIY('${level}')`);
  if (btn) btn.classList.add("active");
  document.querySelectorAll("#diy-grid .diy-card").forEach((card) => {
    const show = level === "all" || card.dataset.difficulty === level;
    card.style.display = show ? "" : "none";
  });
}

async function loadDIYGuides(category, limit) {
  const grid = document.getElementById("diy-grid");
  if (!grid) return;
  try {
    const res = await fetch(`/api/diy-guides?category=${encodeURIComponent(category)}&limit=${limit || 10}`);
    const data = await res.json();
    const guides = data.guides || [];
    if (!guides.length) {
      grid.innerHTML = `<p style="color:#888;">No guides yet for this category — be the first to request one below.</p>`;
      return;
    }
    grid.innerHTML = guides.map(renderCard).join("");
    grid.style.minHeight = "";
    grid.querySelectorAll(".diy-card").forEach((card) => {
      card.classList.add("collapsed");
      card.addEventListener("click", function (e) {
        if (e.target.closest("button, a")) return;
        const isCollapsed = card.classList.contains("collapsed");
        document.querySelectorAll(".diy-card:not(.collapsed)").forEach((c) => {
          if (c !== card) c.classList.add("collapsed");
        });
        card.classList.toggle("collapsed", !isCollapsed);
      });
    });
  } catch (e) {
    grid.innerHTML = `<p style="color:#888;">Couldn't load guides right now — try refreshing.</p>`;
  }
}

document.addEventListener("DOMContentLoaded", function () {
  const grid = document.getElementById("diy-grid");
  if (grid && grid.dataset.category) {
    loadDIYGuides(grid.dataset.category, grid.dataset.limit || 10);
  }
});

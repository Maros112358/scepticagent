const PROVIDERS = ["anthropic", "openai", "gemini"];
const CONSOLE_URLS = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai:    "https://platform.openai.com/api-keys",
  gemini:    "https://aistudio.google.com/app/apikey",
};

// ── Load saved settings ───────────────────────────────────────────────────────
chrome.storage.local.get(
  ["provider", "anthropicKey", "anthropicModel", "openaiKey", "openaiModel", "geminiKey", "geminiModel"],
  (data) => {
    // Active provider tab
    const active = data.provider || "anthropic";
    setActiveTab(active);

    // Populate each provider's fields
    if (data.anthropicKey) { document.getElementById("anthropic-key").value = data.anthropicKey; setStatus("anthropic", true); }
    if (data.anthropicModel) document.getElementById("anthropic-model").value = data.anthropicModel;

    if (data.openaiKey) { document.getElementById("openai-key").value = data.openaiKey; setStatus("openai", true); }
    if (data.openaiModel) document.getElementById("openai-model").value = data.openaiModel;

    if (data.geminiKey) { document.getElementById("gemini-key").value = data.geminiKey; setStatus("gemini", true); }
    if (data.geminiModel) document.getElementById("gemini-model").value = data.geminiModel;

    // Update dots on tabs
    updateDots(data);
  }
);

// ── Provider tab switching ────────────────────────────────────────────────────
document.querySelectorAll(".provider-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const provider = tab.dataset.provider;
    setActiveTab(provider);
    chrome.storage.local.set({ provider });
  });
});

function setActiveTab(provider) {
  document.querySelectorAll(".provider-tab").forEach((t) => t.classList.toggle("active", t.dataset.provider === provider));
  document.querySelectorAll(".provider-section").forEach((s) => s.classList.toggle("visible", s.id === `section-${provider}`));
}

// ── Save / Clear ──────────────────────────────────────────────────────────────
document.querySelectorAll("[data-save]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const p = btn.dataset.save;
    const key = document.getElementById(`${p}-key`).value.trim();
    const model = document.getElementById(`${p}-model`).value;
    if (!key) return;
    chrome.storage.local.set({ [`${p}Key`]: key, [`${p}Model`]: model, provider: p }, () => {
      setStatus(p, true);
      setActiveTab(p);
      const msg = document.getElementById(`${p}-saved`);
      msg.classList.add("show");
      setTimeout(() => msg.classList.remove("show"), 2000);
      chrome.storage.local.get(["anthropicKey", "openaiKey", "geminiKey"], updateDots);
    });
  });
});

document.querySelectorAll("[data-clear]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const p = btn.dataset.clear;
    chrome.storage.local.remove([`${p}Key`], () => {
      document.getElementById(`${p}-key`).value = "";
      setStatus(p, false);
      chrome.storage.local.get(["anthropicKey", "openaiKey", "geminiKey"], updateDots);
    });
  });
});

// ── Show / hide key ───────────────────────────────────────────────────────────
document.querySelectorAll("[data-toggle]").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.toggle);
    const isPassword = input.type === "password";
    input.type = isPassword ? "text" : "password";
    btn.textContent = isPassword ? "🙈" : "👁";
  });
});

// ── Console links ─────────────────────────────────────────────────────────────
PROVIDERS.forEach((p) => {
  document.getElementById(`${p}-console-link`).addEventListener("click", () => {
    chrome.tabs.create({ url: CONSOLE_URLS[p] });
  });
});

// ── Privacy policy link ───────────────────────────────────────────────────────
const PRIVACY_POLICY_URL = "https://maros112358.github.io/verifai/privacy.html";
document.getElementById("privacy-policy-link").addEventListener("click", () => {
  chrome.tabs.create({ url: PRIVACY_POLICY_URL });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(provider, hasKey) {
  const el = document.getElementById(`${provider}-status`);
  el.className = `key-status ${hasKey ? "set" : "unset"}`;
  el.querySelector(".label").textContent = hasKey ? "API key configured" : "No key set";
}

function updateDots(data) {
  document.getElementById("dot-anthropic").className = `tab-dot ${data.anthropicKey ? "set" : ""}`;
  document.getElementById("dot-openai").className    = `tab-dot ${data.openaiKey    ? "set" : ""}`;
  document.getElementById("dot-gemini").className    = `tab-dot ${data.geminiKey    ? "set" : ""}`;
}

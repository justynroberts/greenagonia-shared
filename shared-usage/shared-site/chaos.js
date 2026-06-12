/* ============================================================
   Greenagonia — Chaos Engine + PagerDuty Events API v2
   ------------------------------------------------------------
   Single scenario: bad-payment-deploy — fires all 12 steps
   from the CLI (cli/main.go) with identical timing, dedup
   keys, and custom_details so resolve works from either side.
   ============================================================ */

const PD_ENDPOINT = "https://events.pagerduty.com/v2/enqueue";
const LS_KEY_ROUTING   = "gn_pd_routing_key";
const LS_KEY_CHANGE    = "gn_pd_change_key";
const LS_KEY_LD        = "gn_pd_ld_key";
const LS_KEY_INCIDENTS = "gn_pd_active_incidents";
const LS_KEY_SCENARIO  = "gn_chaos_scenario";

// Mirrors cli/main.go: commonFields
const COMMON = {
  environment:       "production",
  region:            "us-east-1",
  cluster:           "use1-prod-1",
  kubernetes:        true,
  monitoring_system: "datadog",
  datacenter:        "aws-use1",
  runbook_url:       { github: "https://raw.githubusercontent.com/greenagonia/runbooks/refs/heads/main/runbook.md" },
};

// Mirrors cli/main.go: serviceMeta
const SERVICE_META = {
  "payment-gateway":      { namespace: "payments",   deployment: "payment-gateway",      team: "platform-payments",      runbook: "https://wiki.greenagonia.io/runbooks/payment-gateway" },
  "checkout-api":         { namespace: "commerce",   deployment: "checkout-api",          team: "checkout",               runbook: "https://wiki.greenagonia.io/runbooks/checkout-api" },
  "order-service":        { namespace: "commerce",   deployment: "order-service",         team: "orders",                 runbook: "https://wiki.greenagonia.io/runbooks/order-service" },
  "notification-service": { namespace: "platform",   deployment: "notification-service",  team: "platform-notifications", runbook: "https://wiki.greenagonia.io/runbooks/notification-service" },
};

// Primary host per service (first source of each service in the steps array).
const PRIMARY_HOSTS = {
  "payment-gateway":      "payment-gw-prod-3",
  "checkout-api":         "checkout-prod-7",
  "order-service":        "order-prod-2",
  "notification-service": "notif-prod-1",
};

// Mirrors cli/main.go: bad-payment-deploy scenario shared fields.
const BAD_PAYMENT_SHARED = {
  release:            "v2.4.1",
  deploy_id:          "github-deploy-412",
  root_cause_service: "payment-gateway",
};

// bad-payment-deploy steps — mirrors cli/main.go exactly.
// [delaySec, service, summary, description, severity, reportingHost, extraFields]
const BAD_PAYMENT_STEPS = [
  [0,  "payment-gateway",      "Authentication failures elevated",         "Card authorization requests failing for the majority of Amex transactions since the v2.4.1 deploy.",         "critical", "payment-gw-prod-3", { error_class: "java.lang.NullPointerException", card_brand: "amex" }],
  [5,  "payment-gateway",      "Card processor timeouts",                  "Calls to the Adyen processor exceeding the 10s timeout; retries are compounding the load.",                  "critical", "payment-gw-prod-7", { processor: "adyen", timeout_count: 184 }],
  [10, "payment-gateway",      "Service health check failing",             "The /healthz endpoint has failed 12 consecutive probes; instances are being pulled from the load balancer.", "critical", "payment-gw-prod-3", { endpoint: "/healthz", consecutive_failures: 12 }],
  [14, "payment-gateway",      "Error budget burn-rate exceeded",          "Availability SLO burning 14x faster than sustainable; budget exhausted in under 2 hours at this rate.",      "error",    "slo-monitor",       { slo: "payment-gateway-availability", burn_rate_x: 14 }],
  [20, "checkout-api",         "Upstream payment timeouts",                "Requests to payment-gateway timing out at p99 of 9.8s; checkout requests queuing behind them.",              "error",    "checkout-prod-7",   { upstream: "payment-gateway", timeout_p99_ms: 9800 }],
  [25, "checkout-api",         "Checkout completion rate dropped",         "Completed checkouts down from ~280/min to 12/min; customers abandoning after payment errors.",               "error",    "checkout-prod-7",   { complete_per_min: 12, baseline_per_min: 280 }],
  [30, "checkout-api",         "Cart abandonment elevated",                "Real-user monitoring shows 64% of carts abandoned at the payment step.",                                     "warning",  "rum-monitor",       { abandonment_pct: 64 }],
  [36, "order-service",        "Failed-order rate above baseline",         "Orders failing at 412/min against a 34/min baseline; failures correlate with payment declines.",             "error",    "order-prod-2",      { failed_per_min: 412, baseline_per_min: 34 }],
  [41, "order-service",        "Order processing degraded",                "Order pipeline p99 at 8.2s; payment-confirmation steps dominating processing time.",                         "error",    "order-prod-2",      { p99_ms: 8200 }],
  [46, "order-service",        "Downstream payment errors propagating",    "79% of order failures trace to upstream payment-gateway errors.",                                            "error",    "order-prod-5",      { upstream_error_pct: 79 }],
  [52, "notification-service", "Confirmation email queue backlog growing", "order_confirmations queue depth at 18,450 and climbing; emails delayed until orders clear.",                "warning",  "notif-prod-1",      { queue: "order_confirmations", queue_depth: 18450 }],
  [58, "notification-service", "Notification delivery delayed",            "Delivery delayed by more than 60s; current lag is 4 minutes behind real time.",                             "warning",  "notif-prod-3",      { delivery_lag_sec: 240 }],
];

function mergeDetails(service, reportingHost, extra) {
  return {
    ...COMMON,
    ...(SERVICE_META[service] || {}),
    ...BAD_PAYMENT_SHARED,
    service,
    scenario:       "bad-payment-deploy",
    host:           PRIMARY_HOSTS[service] || reportingHost,
    reporting_host: reportingHost,
    synthetic:      true,
    ...extra,
  };
}

// Parse service name from a dedup key: greenagonia/demo/bad-payment-deploy/{service}/{i}
function serviceFromDk(dk) {
  const parts = dk.split("/");
  return parts.length >= 4 ? parts[3] : "payment-gateway";
}

/* ------------------------------------------------------------
   Failure scenarios — only two: healthy and bad-payment-deploy.
   ------------------------------------------------------------ */
const SCENARIOS = {
  healthy: {
    emoji: "✅",
    name: "All systems healthy",
    desc: "Checkout completes normally. No alerts fired.",
    severity: null,
    failStep: null,
    sevClass: "sev-ok",
  },
  payment_timeout: {
    emoji: "⏱️",
    name: "Payment outage (bad-payment-deploy)",
    desc: "Full cascade: payment-gateway → checkout-api → order-service → notification-service. 12 alerts over ~60 s. Dedup keys match the CLI — resolve from either side.",
    severity: "critical",
    failStep: "payment",
    component: "payment-gateway",
    errorCode: "GATEWAY_TIMEOUT_504",
    userMessage: "Our payment provider is taking too long to respond. You have not been charged.",
    slowFactor: 4,
  },
};

/* ------------------------------------------------------------
   Chaos controller
   ------------------------------------------------------------ */
const Chaos = {
  scenario: "healthy",
  _cascadeTimers: [],

  get routingKey() { return localStorage.getItem(LS_KEY_ROUTING) || ""; },
  set routingKey(v) {
    localStorage.setItem(LS_KEY_ROUTING, v.trim());
    this.renderPdStatus();
  },

  get changeKey() { return localStorage.getItem(LS_KEY_CHANGE) || ""; },
  set changeKey(v) { localStorage.setItem(LS_KEY_CHANGE, v.trim()); },

  get ldKey() { return localStorage.getItem(LS_KEY_LD) || ""; },
  set ldKey(v) { localStorage.setItem(LS_KEY_LD, v.trim()); },

  get activeIncidents() {
    try {
      return JSON.parse(localStorage.getItem(LS_KEY_INCIDENTS)) || [];
    } catch {
      return [];
    }
  },
  set activeIncidents(list) {
    localStorage.setItem(LS_KEY_INCIDENTS, JSON.stringify(list));
    this.renderIncidentCount();
  },

  current() {
    return SCENARIOS[this.scenario];
  },

  /* ---------- PagerDuty Events API v2 ---------- */

  async sendEvent(body) {
    if (!this.routingKey) {
      this.logEvent("error", "No routing key configured — event not sent");
      toast("⚠️ No PagerDuty routing key — alert not sent. Double-click the logo to add one.", "error");
      return { ok: false, reason: "no routing key configured" };
    }
    body.routing_key = this.routingKey;
    try {
      const res = await fetch(PD_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 202) {
        return { ok: true, data };
      }
      const reason = data.message || `HTTP ${res.status}`;
      this.logEvent("error", `PD rejected event (${res.status}): ${reason}`);
      toast(`⚠️ PagerDuty rejected the event: ${reason}`, "error");
      return { ok: false, reason };
    } catch (err) {
      this.logEvent("error", `Network error sending to PagerDuty: ${err.message}`);
      toast(`⚠️ Couldn't reach PagerDuty: ${err.message}`, "error");
      return { ok: false, reason: err.message };
    }
  },

  // Post a single change event directly to a service integration key.
  // Uses the same endpoint as alerts but event_action = "change".
  async sendChangeEvent(integrationKey, payload) {
    if (!integrationKey) return { ok: false };
    try {
      const res = await fetch(PD_ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routing_key: integrationKey, event_action: "change", payload }),
      });
      return { ok: res.status === 202 };
    } catch (err) {
      return { ok: false, reason: err.message };
    }
  },

  // Post both change events backdated so they appear in PagerDuty's
  // Recent Changes tab as the root cause just before the incident.
  async sendChangeEvents() {
    const isoAt = (msBefore) => new Date(Date.now() - msBefore).toISOString();

    if (this.changeKey) {
      const r = await this.sendChangeEvent(this.changeKey, {
        summary:   "Deployed payment-gateway v2.4.1 to production",
        timestamp: isoAt(3 * 60 * 1000),
        source:    "GitHub Actions",
        custom_details: {
          deployment_id: "github-deploy-412",
          version:       "v2.4.1",
          commit:        "a3f9c2d",
          branch:        "release/v2.4.1",
          environment:   "production",
          triggered_by:  "deploy-bot",
        },
        links: [{ href: "https://github.com/greenagonia/payment-gateway/actions/runs/412", text: "View deployment" }],
      });
      if (r.ok) this.logEvent("change", "GitHub deploy · payment-gateway v2.4.1 (backdated 3m)");
    }

    if (this.ldKey) {
      const r = await this.sendChangeEvent(this.ldKey, {
        summary:   "Feature flag 'enable-new-payment-processor' enabled in production",
        timestamp: isoAt(2 * 60 * 1000),
        source:    "LaunchDarkly",
        custom_details: {
          flag_key:    "enable-new-payment-processor",
          project:     "greenagonia",
          environment: "production",
          changed_by:  "deploy-bot",
          from:        false,
          to:          true,
        },
        links: [{ href: "https://app.launchdarkly.com/greenagonia/production/features/enable-new-payment-processor", text: "View flag in LaunchDarkly" }],
      });
      if (r.ok) this.logEvent("change", "LaunchDarkly · enable-new-payment-processor → true (backdated 2m)");
    }
  },

  // Fire the bad-payment-deploy cascade.
  // Step 0 fires immediately and its result is returned; steps 1–11 are
  // scheduled in the background matching the CLI's exact delays.
  async triggerIncident(scenarioKey) {
    if (scenarioKey !== "payment_timeout") return { ok: false, reason: "not-alertable" };

    // Post change events first — backdated so they appear as root cause in Recent Changes.
    await this.sendChangeEvents();

    const t0 = Date.now();

    const fireStep = async (i) => {
      const [, service, summary, description, severity, reportingHost, extra] = BAD_PAYMENT_STEPS[i];
      const dk = `greenagonia/demo/bad-payment-deploy/${service}/${i}`;
      const result = await this.sendEvent({
        event_action: "trigger",
        dedup_key:    dk,
        payload: {
          summary,
          source:    reportingHost,
          severity,
          component: service,
          group:     "bad-payment-deploy",
          class:     "greenagonia-scenario",
          custom_details: mergeDetails(service, reportingHost, { ...extra, description }),
        },
      });
      if (result.ok) {
        const incidents = this.activeIncidents;
        if (!incidents.includes(dk)) incidents.push(dk);
        this.activeIncidents = incidents;
        this.logEvent("trigger", `${severity.toUpperCase()} · ${service} · ${summary}`);
      }
      return result;
    };

    // Fire step 0 immediately and return for UI feedback.
    const first = await fireStep(0);

    // Schedule steps 1–11 in the background.
    this._cascadeTimers.forEach(clearTimeout);
    this._cascadeTimers = BAD_PAYMENT_STEPS.slice(1).map((step, idx) => {
      const i = idx + 1;
      const delayMs = step[0] * 1000 - (Date.now() - t0);
      return setTimeout(() => fireStep(i), Math.max(0, delayMs));
    });

    if (first.ok) {
      toast("📟 PagerDuty alert cascade started — bad-payment-deploy", "pd");
    }
    return first;
  },

  async sendTestAlert() {
    const result = await this.sendEvent({
      event_action: "trigger",
      dedup_key: `greenagonia-test-${Date.now()}`,
      client: "Greenagonia Storefront",
      client_url: location.href,
      payload: {
        summary: "[Greenagonia] Test alert from the operations console",
        source: "greenagonia-checkout-prod",
        severity: "info",
        component: "ops-console",
        group: "commerce",
        class: "TEST_EVENT",
        custom_details: { service: "payment-gateway", note: "If you can read this, the integration works." },
      },
    });
    if (result.ok) {
      this.logEvent("trigger", "INFO · test alert sent successfully");
      this.renderPdStatus("ok", "Test alert accepted by PagerDuty ✓");
      toast("📟 Test alert accepted by PagerDuty", "pd");
    } else {
      this.renderPdStatus("err", `Failed: ${result.reason}`);
    }
  },

  async resolveAll() {
    const incidents = this.activeIncidents;
    if (!incidents.length) {
      toast("No active incidents to resolve");
      return;
    }
    // Cancel any in-flight cascade timers.
    this._cascadeTimers.forEach(clearTimeout);
    this._cascadeTimers = [];

    let resolved = 0;
    for (const dk of incidents) {
      const service = serviceFromDk(dk);
      const result = await this.sendEvent({
        event_action: "resolve",
        dedup_key:    dk,
        payload: {
          summary:  "resolved",
          source:   "greenagonia-checkout-prod",
          severity: "info",
          custom_details: { service },
        },
      });
      if (result.ok) {
        resolved++;
        this.logEvent("resolve", `resolved · ${dk}`);
      }
    }
    this.activeIncidents = [];
    toast(`✓ Resolved ${resolved} incident${resolved === 1 ? "" : "s"}`);
  },

  /* ---------- UI ---------- */

  setScenario(key) {
    this.scenario = key;
    localStorage.setItem(LS_KEY_SCENARIO, key);
    document.querySelectorAll(".scenario").forEach((el) => {
      el.classList.toggle("active", el.dataset.key === key);
    });
  },

  logEvent(kind, msg) {
    const log = document.getElementById("event-log");
    const empty = log.querySelector(".event-log__empty");
    if (empty) empty.remove();
    const row = document.createElement("div");
    row.className = "event-log__row";
    const time = new Date().toLocaleTimeString("en-GB", { hour12: false });
    row.innerHTML = `
      <span class="event-log__time">${time}</span>
      <span class="event-log__badge event-log__badge--${kind}">${kind}</span>
      <span class="event-log__msg">${msg}</span>`;
    log.prepend(row);
  },

  renderPdStatus(cls, text) {
    const el = document.getElementById("pd-status");
    if (cls) {
      el.className = `chaos__status ${cls}`;
      el.textContent = text;
      return;
    }
    if (this.routingKey) {
      el.className = "chaos__status ok";
      el.textContent = `Key configured (…${this.routingKey.slice(-4)})`;
    } else {
      el.className = "chaos__status";
      el.textContent = "No key configured";
    }
  },

  renderIncidentCount() {
    const el = document.getElementById("incident-count");
    const n = this.activeIncidents.length;
    el.textContent = n;
    el.classList.toggle("hot", n > 0);
  },

  renderScenarios() {
    const list = document.getElementById("scenario-list");
    list.innerHTML = Object.entries(SCENARIOS)
      .map(([key, s]) => {
        const sev = s.severity
          ? `<span class="sev-tag sev-tag--${s.severity}">${s.severity}</span>`
          : "";
        return `
        <button class="scenario ${s.sevClass || ""} ${key === this.scenario ? "active" : ""}" data-key="${key}">
          <span class="scenario__emoji">${s.emoji}</span>
          <span>
            <span class="scenario__name">${s.name} ${sev}</span>
            <span class="scenario__desc">${s.desc}</span>
          </span>
        </button>`;
      })
      .join("");
    list.querySelectorAll(".scenario").forEach((el) => {
      el.addEventListener("click", () => this.setScenario(el.dataset.key));
    });
  },

  init() {
    const saved = localStorage.getItem(LS_KEY_SCENARIO);
    this.scenario = saved && SCENARIOS[saved] ? saved : "payment_timeout";

    this.renderScenarios();
    this.renderPdStatus();
    this.renderIncidentCount();

    const keyInput = document.getElementById("pd-routing-key");
    keyInput.value = this.routingKey;
    keyInput.addEventListener("change", () => (this.routingKey = keyInput.value));

    const changeInput = document.getElementById("pd-change-key");
    if (changeInput) {
      changeInput.value = this.changeKey;
      changeInput.addEventListener("change", () => (this.changeKey = changeInput.value));
    }

    const ldInput = document.getElementById("pd-ld-key");
    if (ldInput) {
      ldInput.value = this.ldKey;
      ldInput.addEventListener("change", () => (this.ldKey = ldInput.value));
    }

    document.getElementById("pd-test").addEventListener("click", () => this.sendTestAlert());
    document.getElementById("pd-fire-cascade").addEventListener("click", () => this.triggerIncident("payment_timeout"));
    document.getElementById("pd-resolve-all").addEventListener("click", () => this.resolveAll());
    document.getElementById("log-clear").addEventListener("click", () => {
      document.getElementById("event-log").innerHTML =
        '<div class="event-log__empty">No events dispatched yet</div>';
    });

    const panel = document.getElementById("chaos-panel");
    const overlay = document.getElementById("chaos-overlay");
    const open = () => {
      panel.classList.add("open");
      overlay.classList.add("show");
    };
    const close = () => {
      panel.classList.remove("open");
      overlay.classList.remove("show");
    };
    document.getElementById("chaos-close").addEventListener("click", close);
    const opsLink = document.getElementById("ops-link");
    if (opsLink) {
      opsLink.addEventListener("click", (e) => {
        e.preventDefault();
        open();
      });
    }
    overlay.addEventListener("click", close);
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        panel.classList.contains("open") ? close() : open();
      }
      if (e.key === "Escape") close();
    });

    const brand = document.getElementById("footer-brand");
    if (brand) {
      let clicks = 0;
      let timer = null;
      brand.addEventListener("click", () => {
        clicks++;
        clearTimeout(timer);
        timer = setTimeout(() => (clicks = 0), 600);
        if (clicks >= 3) {
          clicks = 0;
          open();
        }
      });
    }

    const params = new URLSearchParams(location.search);
    let keyParamsFound = false;
    if (params.get("pdkey")) {
      this.routingKey = params.get("pdkey");
      keyInput.value = this.routingKey;
      keyParamsFound = true;
      params.delete("pdkey");
    }
    if (params.get("pdchangekey")) {
      this.changeKey = params.get("pdchangekey");
      if (changeInput) changeInput.value = this.changeKey;
      keyParamsFound = true;
      params.delete("pdchangekey");
    }
    if (params.get("pdldkey")) {
      this.ldKey = params.get("pdldkey");
      if (ldInput) ldInput.value = this.ldKey;
      keyParamsFound = true;
      params.delete("pdldkey");
    }
    if (keyParamsFound) {
      // New session — arm the failure scenario so checkout fails on first attempt.
      this.setScenario("payment_timeout");
      this.logEvent("resolve", "PagerDuty keys loaded from URL");
      const clean = location.pathname + (params.size ? `?${params}` : "") + location.hash;
      history.replaceState(null, "", clean);
      toast("📟 PagerDuty keys saved", "pd");
    }
    if (params.get("ops") === "1") open();

    this.initKeyPrompt();
  },

  /* ---------- first-run routing key prompt ---------- */

  initKeyPrompt() {
    const modal = document.getElementById("pdkey-modal");
    const input = document.getElementById("pdkey-input");
    const clearBtn = document.getElementById("pdkey-clear");
    const consoleInput = document.getElementById("pd-routing-key");

    const openPrompt = () => {
      input.value = "";
      clearBtn.hidden = !this.routingKey;
      modal.hidden = false;
      setTimeout(() => input.focus(), 60);
    };
    const closePrompt = () => (modal.hidden = true);

    const saveKey = () => {
      const v = input.value.trim();
      if (!v) return;
      this.routingKey = v;
      if (consoleInput) consoleInput.value = v;
      this.logEvent("resolve", "routing key saved");
      toast("📟 PagerDuty routing key saved", "pd");
      closePrompt();
    };

    document.getElementById("pdkey-form").addEventListener("submit", (e) => {
      e.preventDefault();
      saveKey();
    });

    input.addEventListener("input", () => {
      if (input.value.trim().length >= 32) saveKey();
    });

    document.getElementById("pdkey-skip").addEventListener("click", () => {
      sessionStorage.setItem("gn_pdkey_skip", "1");
      closePrompt();
    });

    clearBtn.addEventListener("click", () => {
      localStorage.removeItem(LS_KEY_ROUTING);
      this.renderPdStatus();
      if (consoleInput) consoleInput.value = "";
      clearBtn.hidden = true;
      toast("Routing key removed");
    });

    const logo = document.getElementById("header-logo");
    if (logo) {
      let clickTimer = null;
      logo.addEventListener("click", (e) => {
        e.preventDefault();
        if (clickTimer) {
          clearTimeout(clickTimer);
          clickTimer = null;
          openPrompt();
        } else {
          clickTimer = setTimeout(() => {
            clickTimer = null;
            location.href = logo.getAttribute("href");
          }, 280);
        }
      });
    }

    if (!this.routingKey && !sessionStorage.getItem("gn_pdkey_skip")) {
      openPrompt();
    }
  },
};

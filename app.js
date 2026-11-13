/*
 * Centauri Monitor — read-only dashboard for the Elegoo Centauri Carbon.
 *
 * Protocol: SDCP v3 over WebSocket (ws://<printer>:3030/websocket), JSON frames.
 * Camera:   MJPEG over HTTP (http://<printer>:3031/video), enabled with Cmd 386.
 * Nothing here sends anything that changes the printer's state, apart from
 * asking it to turn the camera stream on.
 */
(() => {
  "use strict";

  const WS_PORT = 3030;
  const VIDEO_PORT = 3031;
  const CMD = { STATUS: 0, ATTRIBUTES: 1, VIDEO: 386 };
  const STORAGE_KEY = "centauri-monitor.host";

  // Proxy mode: the web server relays the printer at ./printer/ws and
  // ./printer/video, so the browser never needs to reach the printer itself.
  // On automatically for HTTPS pages (direct ws:// would be blocked as mixed content).
  const PARAMS = new URLSearchParams(location.search);
  const PROXY = PARAMS.get("proxy") !== "0" && (location.protocol === "https:" || PARAMS.has("proxy"));
  const proxyUrl = (path, ws) => {
    const u = new URL("printer/" + path, location.href);
    if (ws) u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    return u.href;
  };

  // CurrentStatus[0] — machine-level state.
  const MACHINE = {
    0: "Idle", 1: "Printing", 2: "Transferring file", 3: "Exposure test", 4: "Self-test",
    5: "Leveling", 6: "Input shaping", 7: "Stopping", 8: "Stopped", 9: "Homing",
    10: "Loading filament", 11: "PID tuning", 12: "Recovering",
  };
  // PrintInfo.Status — FDM (Centauri Carbon) sub-status table.
  const PRINT = {
    0: "Idle", 1: "Homing", 5: "Pausing", 6: "Paused", 7: "Stopping", 8: "Stopped",
    9: "Complete", 10: "Checking file", 11: "Checking printer", 12: "Resuming", 13: "Printing",
    14: "Error", 15: "Auto leveling", 16: "Preheating", 17: "Resonance testing",
    18: "Printing", 19: "Printing", 20: "Printing", 21: "Printing", 22: "Printing",
    23: "Feeding filament", 24: "Unloading filament", 25: "Filament unload error", 26: "Paused",
  };
  const TONE_BY_PRINT = {
    5: "warn", 6: "warn", 26: "warn", 7: "warn", 8: "idle", 9: "ok", 14: "err", 25: "err",
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    feed: $("feed"), camMsg: $("camMsg"), live: $("liveBadge"), clock: $("clock"),
    state: $("state"), stateText: $("stateText"), machineName: $("machineName"),
    filename: $("filename"), pct: $("pct"), bar: $("bar"), remaining: $("remaining"),
    finish: $("finish"), layer: $("layer"), elapsed: $("elapsed"), speed: $("speed"),
    fanModel: $("fanModel"), fanAux: $("fanAux"), fanBox: $("fanBox"), foot: $("foot"),
    settings: $("settings"), hostInput: $("hostInput"),
  };

  let host = PROXY ? "" : resolveHost();
  const label = () => (PROXY ? location.host : host);
  let ws = null;
  let mainboardId = "";
  let status = {};
  let lastUpdate = 0;
  let reconnectDelay = 1000;
  let pingTimer = null;
  let pollTimer = null;
  let camRetry = null;
  let camRetryDelay = 2000;

  // ---------- Host / settings ----------

  function resolveHost() {
    const q = new URLSearchParams(location.search).get("printer");
    if (q) { save(q); return q.trim(); }
    try { return localStorage.getItem(STORAGE_KEY) || ""; } catch { return ""; }
  }
  function save(h) { try { localStorage.setItem(STORAGE_KEY, h.trim()); } catch {} }

  function openSettings() {
    el.hostInput.value = host;
    el.settings.showModal();
  }
  el.settings.addEventListener("close", () => {
    if (el.settings.returnValue !== "save") return;
    const h = el.hostInput.value.trim().replace(/^\w+:\/\//, "").replace(/[/:].*$/, "");
    if (!h) return;
    host = h;
    save(h);
    restart();
  });
  $("settingsBtn").addEventListener("click", openSettings);
  if (PROXY) $("settingsBtn").hidden = true;

  // ---------- WebSocket ----------

  function restart() {
    if (ws) { ws.onclose = null; ws.close(); }
    clearTimers();
    status = {};
    mainboardId = "";
    reconnectDelay = 1000;
    stopCamera("Connecting to camera…");
    connect();
  }

  function clearTimers() {
    clearInterval(pingTimer);
    clearInterval(pollTimer);
    clearTimeout(camRetry);
  }

  function connect() {
    if (!PROXY && !host) { setState("No printer set", "idle"); openSettings(); return; }
    setState("Connecting…", "idle");
    el.foot.textContent = `Connecting to ${label()}…`;

    try {
      ws = new WebSocket(PROXY ? proxyUrl("ws", true) : `ws://${host}:${WS_PORT}/websocket`);
    } catch (e) {
      setState("Bad address", "err");
      return;
    }

    ws.onopen = () => {
      reconnectDelay = 1000;
      send(CMD.ATTRIBUTES);
      send(CMD.STATUS);
      send(CMD.VIDEO, { Enable: 1 });
      // Keep-alive: the printer answers a plain-text "ping" with "pong".
      pingTimer = setInterval(() => ws.readyState === 1 && ws.send("ping"), 10000);
      // The printer pushes status on change; poll as a safety net.
      pollTimer = setInterval(() => send(CMD.STATUS), 5000);
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data !== "string" || ev.data === "pong") return;
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      handle(msg);
    };

    ws.onclose = () => {
      clearTimers();
      setState("Offline", "err");
      el.foot.textContent = `Lost connection to ${label()} — retrying…`;
      stopCamera("Camera offline");
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 30000);
    };
  }

  function send(cmd, data = {}) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({
      Id: "",
      Data: {
        Cmd: cmd,
        Data: data,
        RequestID: Math.random().toString(16).slice(2) + Date.now().toString(16),
        MainboardID: mainboardId,
        TimeStamp: Math.floor(Date.now() / 1000),
        From: 0,
      },
      Topic: `sdcp/request/${mainboardId}`,
    }));
  }

  function handle(msg) {
    const id = msg.MainboardID || msg.Data?.MainboardID;
    if (id && !mainboardId) mainboardId = id;

    if (msg.Status) {
      merge(status, msg.Status);
      lastUpdate = Date.now();
      render();
    }
    if (msg.Attributes) {
      const a = msg.Attributes;
      el.machineName.textContent = a.Name || a.MachineName || "Centauri Carbon";
    }
    const d = msg.Data;
    if (d && d.Cmd === CMD.VIDEO) handleVideo(d.Data || {});
  }

  function merge(target, src) {
    for (const [k, v] of Object.entries(src)) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        target[k] = merge(target[k] && typeof target[k] === "object" ? target[k] : {}, v);
      } else {
        target[k] = v;
      }
    }
    return target;
  }

  // ---------- Camera ----------

  function handleVideo(data) {
    if (data.Ack === 1) return stopCamera("Camera busy — too many viewers connected", true);
    if (data.Ack === 2) return stopCamera("No camera detected");
    if (PROXY) return startCamera(proxyUrl("video"));
    let url = data.VideoUrl || `${host}:${VIDEO_PORT}/video`;
    if (!/^https?:\/\//.test(url)) url = "http://" + url;
    startCamera(url);
  }

  function startCamera(url) {
    clearTimeout(camRetry);
    el.camMsg.hidden = false;
    el.camMsg.textContent = "Loading camera…";
    // Cache-buster forces a fresh MJPEG connection on retry.
    el.feed.src = url + (url.includes("?") ? "&" : "?") + "t=" + Date.now();
  }

  function stopCamera(text, retry) {
    el.feed.removeAttribute("src");
    el.live.classList.remove("on");
    el.camMsg.hidden = false;
    el.camMsg.textContent = text;
    if (retry) scheduleCamRetry();
  }

  function scheduleCamRetry() {
    clearTimeout(camRetry);
    camRetry = setTimeout(() => send(CMD.VIDEO, { Enable: 1 }), camRetryDelay);
    camRetryDelay = Math.min(camRetryDelay * 2, 30000);
  }

  el.feed.addEventListener("load", () => {
    camRetryDelay = 2000;
    el.camMsg.hidden = true;
    el.live.classList.add("on");
  });
  el.feed.addEventListener("error", () => {
    if (!el.feed.getAttribute("src")) return;
    stopCamera("Camera stream dropped — reconnecting…", true);
  });

  // Fullscreen
  const camEl = $("camera");
  function toggleFs() {
    if (document.fullscreenElement) document.exitFullscreen();
    else camEl.requestFullscreen?.();
  }
  $("fsBtn").addEventListener("click", toggleFs);

  // Fill (crop to edges, default) vs fit (whole frame, may letterbox).
  const FIT_KEY = "centauri-monitor.fit";
  try { camEl.classList.toggle("fit", localStorage.getItem(FIT_KEY) === "1"); } catch {}
  function toggleFit() {
    const fit = camEl.classList.toggle("fit");
    try { localStorage.setItem(FIT_KEY, fit ? "1" : "0"); } catch {}
  }
  $("fitBtn").addEventListener("click", toggleFit);
  camEl.addEventListener("dblclick", toggleFs);
  document.addEventListener("keydown", (e) => {
    if (el.settings.open || e.ctrlKey || e.metaKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "f") toggleFs();
    else if (k === "z") toggleFit();
  });

  // ---------- Rendering ----------

  function setState(text, tone) {
    el.stateText.textContent = text;
    el.state.dataset.tone = tone;
    document.title = text === "Idle" ? "Centauri Monitor" : `${text} · Centauri Monitor`;
  }

  function render() {
    const s = status;
    const pi = s.PrintInfo || {};
    const machine = Array.isArray(s.CurrentStatus) ? s.CurrentStatus[0] : s.CurrentStatus;
    const ps = pi.Status;
    const active = machine === 1 || [5, 6, 12, 13, 16, 18, 19, 20, 21, 22, 26].includes(ps);

    // State label
    let text, tone;
    if (active || [9, 14, 25].includes(ps)) {
      text = PRINT[ps] ?? "Printing";
      tone = TONE_BY_PRINT[ps] ?? "accent";
    } else {
      text = MACHINE[machine] ?? "Idle";
      tone = machine === 0 || machine == null ? "idle" : "accent";
    }
    setState(text, tone);

    // Job
    const hasJob = !!pi.Filename && (active || ps === 9 || ps === 8);
    el.filename.textContent = hasJob ? pi.Filename.replace(/\.gcode$/i, "") : ps === 9 ? "Print finished" : "No active print";

    let pct = Number(pi.Progress);
    if (!Number.isFinite(pct) && pi.TotalLayer) pct = (pi.CurrentLayer / pi.TotalLayer) * 100;
    if (!hasJob || !Number.isFinite(pct)) pct = 0;
    if (ps === 9) pct = 100;
    pct = Math.max(0, Math.min(100, pct));
    el.pct.textContent = Math.floor(pct);
    el.bar.style.width = pct + "%";

    // CC reports ticks in seconds.
    const cur = Number(pi.CurrentTicks) || 0;
    const tot = Number(pi.TotalTicks) || 0;
    const left = Math.max(0, tot - cur);
    el.elapsed.textContent = hasJob && cur ? dur(cur) : "—";
    el.remaining.textContent = hasJob && active && tot ? dur(left) : ps === 9 ? "Done" : "—";
    el.finish.textContent = hasJob && active && tot ? clockAt(Date.now() + left * 1000) : "—";
    el.layer.textContent = hasJob && pi.TotalLayer ? `${pi.CurrentLayer ?? 0} / ${pi.TotalLayer}` : "—";
    el.speed.textContent = hasJob && pi.PrintSpeedPct ? `${pi.PrintSpeedPct}%` : "—";

    // Temps
    temp("nozzle", s.TempOfNozzle, s.TempTargetNozzle, 300);
    temp("bed", s.TempOfHotbed, s.TempTargetHotbed, 120);
    temp("box", s.TempOfBox, s.TempTargetBox, 70);

    // Fans
    const f = s.CurrentFanSpeed || {};
    el.fanModel.textContent = fan(f.ModelFan);
    el.fanAux.textContent = fan(f.AuxiliaryFan);
    el.fanBox.textContent = fan(f.BoxFan);

    el.foot.textContent = (PROXY ? "via proxy" : host) + " · updated just now";
  }

  function temp(key, cur, tgt, max) {
    const row = document.querySelector(`.temp[data-key="${key}"]`);
    const c = Number(cur), t = Number(tgt);
    row.querySelector(".cur").textContent = Number.isFinite(c) ? `${c.toFixed(1)}°` : "—";
    row.querySelector(".tgt").textContent = t > 0 ? `/ ${Math.round(t)}°` : "";
    row.querySelector(".t-bar > *").style.width = Number.isFinite(c) ? Math.min(100, (c / max) * 100) + "%" : "0";
    const at = t > 0 && Math.abs(c - t) <= 3;
    row.classList.toggle("at-temp", at);
    row.classList.toggle("heating", t > 0 && !at);
  }

  const fan = (v) => (v == null ? "—" : `${Math.round(v)}%`);

  function dur(sec) {
    sec = Math.round(sec);
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
    if (h) return `${h}h ${String(m).padStart(2, "0")}m`;
    if (m) return `${m}m`;
    return `${sec}s`;
  }

  function clockAt(ms) {
    const d = new Date(ms);
    const t = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const days = Math.round((new Date(d).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5);
    return days === 0 ? t : days === 1 ? `Tomorrow ${t}` : `${d.toLocaleDateString([], { weekday: "short" })} ${t}`;
  }

  // Clock + staleness indicator
  setInterval(() => {
    el.clock.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    if (lastUpdate && ws?.readyState === 1) {
      const age = Math.round((Date.now() - lastUpdate) / 1000);
      el.foot.textContent = el.foot.textContent.replace(/ · updated .*$/, age < 3 ? " · updated just now" : ` · updated ${age}s ago`);
    }
  }, 1000);

  connect();
})();

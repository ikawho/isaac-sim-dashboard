/* Isaac Sim Workspace - frontend without a build step */
(() => {
  "use strict";
  const CFG = window.APP_CONFIG;
  const REDIRECT = location.origin + "/";
  const $ = (id) => document.getElementById(id);
  const store = sessionStorage;

  // ------------------------------------------------------------ Helpers
  const toastEl = $("toast");
  let toastTimer;
  function toast(msg, isError = false) {
    toastEl.textContent = msg;
    toastEl.classList.toggle("error", isError);
    toastEl.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.hidden = true), isError ? 7000 : 3500);
  }
  const fmtSize = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${(b / 1024).toFixed(1)} KB`
    : b < 1073741824 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1073741824).toFixed(2)} GB`;
  const fmtDate = (s) => new Date(s).toLocaleString("en-GB", { dateStyle: "short", timeStyle: "short" });
  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    kids.flat().forEach((k) => n.append(k));
    return n;
  };
  const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  const randomString = () => b64url(crypto.getRandomValues(new Uint8Array(32)));
  const decodeJwt = (t) => JSON.parse(decodeURIComponent(escape(atob(t.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")))));

  // ------------------------------------------------------------ Login (OAuth2 code + PKCE)
  async function login() {
    const verifier = randomString();
    const state = randomString();
    store.setItem("pkce_verifier", verifier);
    store.setItem("pkce_state", state);
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const q = new URLSearchParams({
      response_type: "code", client_id: CFG.clientId, redirect_uri: REDIRECT,
      scope: "openid email profile", state, code_challenge_method: "S256", code_challenge: challenge,
    });
    location.assign(`${CFG.cognitoDomain}/oauth2/authorize?${q}`);
  }

  async function tokenRequest(params) {
    const r = await fetch(`${CFG.cognitoDomain}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: CFG.clientId, ...params }),
    });
    if (!r.ok) throw new Error("Token request failed");
    const t = await r.json();
    store.setItem("access_token", t.access_token);
    store.setItem("id_token", t.id_token);
    if (t.refresh_token) store.setItem("refresh_token", t.refresh_token);
  }

  async function handleRedirect() {
    const p = new URLSearchParams(location.search);
    if (!p.has("code")) return;
    history.replaceState(null, "", "/");
    if (p.get("state") !== store.getItem("pkce_state")) throw new Error("Invalid login state");
    await tokenRequest({
      grant_type: "authorization_code", code: p.get("code"),
      redirect_uri: REDIRECT, code_verifier: store.getItem("pkce_verifier"),
    });
    store.removeItem("pkce_verifier");
    store.removeItem("pkce_state");
  }

  async function accessToken() {
    const t = store.getItem("access_token");
    if (t && decodeJwt(t).exp * 1000 > Date.now() + 60000) return t;
    const rt = store.getItem("refresh_token");
    if (!rt) throw new Error("not-logged-in");
    await tokenRequest({ grant_type: "refresh_token", refresh_token: rt });
    return store.getItem("access_token");
  }

  function logout() {
    store.clear();
    const q = new URLSearchParams({ client_id: CFG.clientId, logout_uri: REDIRECT });
    location.assign(`${CFG.cognitoDomain}/logout?${q}`);
  }

  // ------------------------------------------------------------ API
  async function api(method, path, body) {
    const r = await fetch(CFG.apiUrl + path, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || data.message || `Error ${r.status}`);
    return data;
  }

  async function busy(btn, fn) {
    btn.disabled = true;
    try { await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
  }

  // ------------------------------------------------------------ Machine
  const PHASES = ["booting", "setup", "pulling", "syncing", "building", "starting", "ready"];
  const STATE_TEXT = {
    none: "No machine", requesting: "Requesting machine", pending: "Starting", running: "Running",
    stopping: "Stopping", stopped: "Stopped", "shutting-down": "Deleting",
  };
  let pollTimer;

  function renderInstance(s) {
    const st = s.state;
    let text = STATE_TEXT[st] || st, dot = "", detail = "";
    if (st === "running") {
      if (s.phase === "ready") { text = "Ready"; dot = "ok"; detail = "Isaac Sim is running and reachable."; }
      else if (s.phase === "error") { text = "Start failed"; dot = "err"; detail = s.detail; }
      else {
        text = "Setting up"; dot = "busy"; detail = s.detail;
        const mins = s.phaseSince ? Math.floor((Date.now() / 1000 - s.phaseSince) / 60) : null;
        if (mins != null && mins >= 1) detail += ` (${mins} min in this step)`;
        // normal durations: pulling ~10-20 min on first start, starting up to ~30 min (shader cache)
        const limit = { pulling: 40, starting: 45 }[s.phase] || 20;
        if (mins != null && mins >= limit) {
          dot = "err";
          detail += " – this is taking unusually long. Check the boot log below.";
        }
      }
    } else if (st === "requesting") {
      dot = "busy"; detail = `${s.detail || "Looking for free GPU capacity"} …`;
    } else if (st === "pending" || st === "stopping" || st === "shutting-down") {
      dot = "busy";
      detail = st === "pending" ? "AWS is provisioning the GPU instance." : "";
    } else if (st === "stopped") {
      detail = "Disk and shader cache are kept. Starting takes only a few minutes.";
    } else if (st === "none") {
      detail = "Start a GPU machine with Isaac Sim. The first start takes about 20–30 minutes.";
    }
    if (s.lastError && (st === "none" || st === "stopped")) {
      text = "Start failed"; dot = "err"; detail = s.lastError;
    }
    $("m-state").textContent = text;
    $("m-dot").className = `dot ${dot}`;
    $("m-detail").textContent = detail || "";
    $("m-type").textContent = [s.instanceType, s.zone].filter(Boolean).join(" · ");
    renderSearch(s);

    const track = $("m-track");
    const showTrack = st === "pending" || st === "requesting" || (st === "running" && s.phase !== "error");
    track.hidden = !showTrack;
    if (showTrack) {
      const idx = st === "pending" || st === "requesting" ? 0 : Math.max(0, PHASES.indexOf(s.phase));
      [...track.children].forEach((li, i) => {
        li.className = i < idx || s.phase === "ready" ? "done" : i === idx ? "now" : "";
      });
    }

    // boot log: available while the machine runs; refreshed with every status poll while open
    const logBox = $("m-log");
    logBox.hidden = st !== "running";
    if (!logBox.hidden && logBox.open) loadLog();

    const open = $("btn-open");
    open.hidden = !s.viewerUrl;
    if (s.viewerUrl) open.href = s.viewerUrl;
    $("btn-start").hidden = !(st === "none" || st === "stopped");
    $("btn-stop").hidden = !(st === "running" || st === "pending");
    $("btn-allow").hidden = st !== "running";
    $("btn-terminate").hidden = !(st === "running" || st === "stopped");

    $("m-facts").hidden = st === "none" || st === "requesting";
    $("f-ip").textContent = s.publicIp || "–";
    $("f-native-ip").textContent = s.publicIp || "–";
    $("f-allowed").textContent = (s.allowedIps || []).join(", ") || "–";
    $("f-hours").textContent = s.runningHours != null ? `${s.runningHours.toLocaleString("en-GB")} h` : "–";
    if (s.maxSessionHours) $("f-max").textContent = s.maxSessionHours;

    const transitional = ["requesting", "pending", "stopping", "shutting-down"].includes(st) || (st === "running" && s.phase !== "ready" && s.phase !== "error");
    clearTimeout(pollTimer);
    pollTimer = setTimeout(loadInstance, transitional ? 8000 : 45000);
  }

  // ------------------------------------------------------------ GPU capacity search (type x zone grid)
  const RESULT = {
    trying:        ["Checking …", "busy"],
    launched:      ["Started", "ok"],
    no_capacity:   ["No capacity", "err"],
    not_offered:   ["Not offered", ""],
    quota:         ["Quota full", "warn"],
    skipped_quota: ["Skipped", ""],
    not_tried:     ["Not needed", ""],
    error:         ["Error", "err"],
  };

  const RESULT_HELP = {
    quota: "Running On-Demand G and VT instances quota (vCPUs) is too small for this type",
    skipped_quota: "The vCPU quota applies to the whole region, so other zones were not tried",
    not_offered: "AWS does not offer this instance type in this zone",
    not_tried: "Not tried because an earlier combination already worked",
  };

  function renderSearch(s) {
    const box = $("m-search");
    const search = s.search;
    // Show the search while it runs, when it failed, or for the machine it started.
    // Once that machine is stopped or deleted, the old result is no longer relevant.
    const relevant = search && (search.phase === "requesting" || search.phase === "error"
      || ["pending", "running"].includes(s.state));
    box.hidden = !relevant || !search.types || !search.types.length;
    if (box.hidden) return;
    const running = search.phase === "requesting";
    const zones = search.zones || [];
    $("s-when").textContent = running ? "running now" : `at ${new Date(search.ts * 1000).toLocaleTimeString("en-GB", { timeStyle: "short" })}`;

    // summary line: which machine was found and whether it is connected (Isaac Sim stream ready)
    let summary;
    if (running) {
      const tried = Object.values(search.attempts || {}).filter((a) => a.result !== "trying").length;
      summary = `Checked ${tried} of ${search.types.length * zones.length} combinations …`;
    } else if (search.phase === "error") {
      summary = `No machine started: ${search.detail}`;
    } else {
      const hit = Object.entries(search.attempts || {}).find(([, a]) => a.result === "launched");
      const [type, zone] = hit ? hit[0].split("|") : [s.instanceType, s.zone];
      const conn = s.state === "running" && s.phase === "ready" ? "connected – Isaac Sim is ready"
        : s.state === "running" ? "not connected yet – Isaac Sim is still starting"
        : s.state === "pending" ? "not connected yet – machine is booting"
        : "not connected";
      summary = `Started ${type || "?"} in ${zone || "?"}: ${conn}.`;
    }
    $("s-summary").textContent = summary;

    // zone headers: "eu-central-1a" -> "Zone 1a" (full name as tooltip)
    $("s-head").replaceChildren(el("tr", {}, el("th", { textContent: "Type" }),
      ...zones.map((z) => el("th", { textContent: `Zone ${z.split("-").pop()}`, title: z }))));
    $("s-body").replaceChildren(...search.types.map((t) => el("tr", {},
      el("td", {}, el("code", { textContent: t })),
      ...zones.map((z) => {
        const a = (search.attempts || {})[`${t}|${z}`];
        const [label, cls] = a ? (RESULT[a.result] || [a.code || a.result, "err"]) : [running ? "Waiting" : "Not tried", ""];
        return el("td", {}, el("span", { className: `pill ${cls}`, textContent: label, title: (a && a.code) || RESULT_HELP[a && a.result] || "" }));
      }),
    )));
  }

  async function loadLog() {
    try {
      const { log, updated } = await api("GET", "/instance/log");
      const pre = $("log-text");
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
      pre.textContent = log || "No log yet. The machine uploads it every 15 seconds once the setup script runs.";
      if (atBottom) pre.scrollTop = pre.scrollHeight;
      $("log-when").textContent = updated ? `· updated ${new Date(updated).toLocaleTimeString("en-GB", { timeStyle: "medium" })}` : "";
    } catch (e) { $("log-text").textContent = e.message; }
  }
  $("m-log").addEventListener("toggle", (e) => { if (e.target.open) loadLog(); });

  async function loadInstance() {
    try { renderInstance(await api("GET", "/instance")); }
    catch (e) { toast(e.message, true); clearTimeout(pollTimer); pollTimer = setTimeout(loadInstance, 30000); }
  }

  $("btn-start").onclick = (e) => busy(e.currentTarget, async () => {
    renderInstance(await api("POST", "/instance/start"));
    toast("Machine requested. Finding a free GPU can take a minute.");
  });
  $("btn-stop").onclick = (e) => busy(e.currentTarget, async () => {
    renderInstance(await api("POST", "/instance/stop"));
    toast("Machine is stopping. Your files are saved first.");
  });
  $("btn-allow").onclick = (e) => busy(e.currentTarget, async () => {
    renderInstance(await api("POST", "/instance/allow-ip"));
    toast("Access switched to your current IP address.");
  });
  $("btn-terminate").onclick = (e) => {
    if (!confirm("Delete the machine permanently? Disk and shader cache will be lost, My files are kept. Changes from the last 2 minutes that were not yet synced may be lost.")) return;
    busy(e.currentTarget, async () => {
      await api("POST", "/instance/terminate");
      toast("Machine is being deleted.");
      setTimeout(loadInstance, 2000);
    });
  };

  // ------------------------------------------------------------ My files
  async function loadFiles() {
    try {
      const { files } = await api("GET", "/files");
      const tbody = $("file-list");
      tbody.replaceChildren(...files.map((f) => el("tr", {},
        el("td", { className: "name", textContent: f.name }),
        el("td", { className: "num", textContent: fmtSize(f.size) }),
        el("td", { textContent: fmtDate(f.lastModified) }),
        el("td", { className: "row-actions" },
          el("button", { className: "link", textContent: "Download", onclick: () => download(f.name) }),
          el("button", { className: "link danger", textContent: "Delete", onclick: () => removeFile(f.name) })),
      )));
      $("files-empty").hidden = files.length > 0;
    } catch (e) { toast(e.message, true); }
  }

  async function download(name) {
    try {
      const { url } = await api("GET", `/files/download-url?name=${encodeURIComponent(name)}`);
      location.assign(url);
    } catch (e) { toast(e.message, true); }
  }

  async function removeFile(name) {
    if (!confirm(`Delete “${name}” from My files?`)) return;
    try { await api("DELETE", `/files?name=${encodeURIComponent(name)}`); toast("File deleted."); loadFiles(); }
    catch (e) { toast(e.message, true); }
  }

  function putWithProgress(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("PUT", url);
      x.upload.onprogress = (ev) => ev.lengthComputable && onProgress(ev.loaded / ev.total);
      x.onload = () => (x.status < 300 ? resolve() : reject(new Error(`Upload failed (${x.status})`)));
      x.onerror = () => reject(new Error("Upload failed (network)"));
      x.send(file);
    });
  }

  async function upload(fileList) {
    const list = $("uploads");
    for (const file of fileList) {
      const name = file.webkitRelativePath || file.name;
      const pct = el("span", { textContent: "0 %" });
      const row = el("li", {}, el("span", { textContent: name }), pct);
      list.append(row);
      try {
        if (file.size > 5 * 1024 ** 3) throw new Error("Please put files larger than 5 GB directly on the machine.");
        const { url } = await api("POST", "/files/upload-url", { name });
        await putWithProgress(url, file, (p) => (pct.textContent = `${Math.round(p * 100)} %`));
        row.remove();
      } catch (e) {
        pct.textContent = "Error";
        toast(`${name}: ${e.message}`, true);
      }
    }
    loadFiles();
  }

  $("file-input").onchange = (e) => { upload([...e.target.files]); e.target.value = ""; };
  const dz = $("dropzone");
  ["dragenter", "dragover"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", (e) => upload([...e.dataTransfer.files]));

  // ------------------------------------------------------------ Admin
  const INST_PILL = { running: "ok", pending: "busy", stopping: "busy" };

  async function loadAdmin() {
    try {
      const [{ users }, { instances }] = await Promise.all([api("GET", "/admin/users"), api("GET", "/admin/instances")]);
      $("user-list").replaceChildren(...users.map((u) => el("tr", {},
        el("td", { className: "name", textContent: u.email || u.username }),
        el("td", { textContent: !u.enabled ? "Disabled" : u.status === "FORCE_CHANGE_PASSWORD" ? "Invited" : "Active" }),
        el("td", { textContent: u.admin ? "Administrator" : "User" }),
        el("td", {}, el("span", { className: `pill ${INST_PILL[u.instance] || ""}`, textContent: STATE_TEXT[u.instance] || u.instance })),
        el("td", { className: "row-actions" },
          el("button", { className: "link", textContent: u.admin ? "Remove admin" : "Make admin",
            onclick: () => adminAction("POST", u, { admin: !u.admin }) }),
          el("button", { className: "link", textContent: u.enabled ? "Disable" : "Enable",
            onclick: () => adminAction("POST", u, { enabled: !u.enabled }) }),
          el("button", { className: "link danger", textContent: "Delete", onclick: () => {
            if (confirm(`Delete ${u.email}? This user's machine and all their files will be deleted too.`)) adminAction("DELETE", u);
          } })),
      )));
      $("instance-list").replaceChildren(...instances.map((i) => el("tr", {},
        el("td", { className: "name", textContent: i.ownerEmail || i.owner }),
        el("td", {}, el("span", { className: `pill ${INST_PILL[i.state] || ""}`,
          textContent: (STATE_TEXT[i.state] || i.state) + (i.phase && i.phase !== "ready" ? ` (${i.phase})` : "") })),
        el("td", { textContent: i.instanceType }),
        el("td", { className: "num", textContent: i.runningHours != null ? i.runningHours.toLocaleString("en-GB") : "–" }),
        el("td", {}, el("code", { textContent: i.publicIp || "–" })),
        el("td", { className: "row-actions" },
          i.state === "running" ? el("button", { className: "link", textContent: "Stop", onclick: () => instAction(i.instanceId, "stop") }) : "",
          el("button", { className: "link danger", textContent: "Delete", onclick: () => {
            if (confirm("Delete this machine permanently?")) instAction(i.instanceId, "terminate");
          } })),
      )));
      $("inst-empty").hidden = instances.length > 0;
    } catch (e) { toast(e.message, true); }
  }

  async function adminAction(method, u, body) {
    try {
      await api(method, `/admin/users/${encodeURIComponent(u.username)}`, body);
      toast("Saved.");
      loadAdmin();
    } catch (e) { toast(e.message, true); }
  }
  async function instAction(id, action) {
    try { await api("POST", `/admin/instances/${id}/${action}`); toast("Done."); loadAdmin(); }
    catch (e) { toast(e.message, true); }
  }

  $("form-user").onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    busy(btn, async () => {
      await api("POST", "/admin/users", { email: $("new-email").value, admin: $("new-admin").checked });
      toast("Invitation sent by email.");
      e.target.reset();
      loadAdmin();
    });
  };

  // ------------------------------------------------------------ Navigation
  document.querySelectorAll(".tab").forEach((t) => (t.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.setAttribute("aria-selected", x === t));
    const v = t.dataset.view;
    $("view-workspace").hidden = v !== "workspace";
    $("view-admin").hidden = v !== "admin";
    if (v === "admin") loadAdmin();
  }));

  // ------------------------------------------------------------ Start
  $("btn-login").onclick = login;
  $("btn-logout").onclick = logout;

  (async function init() {
    try {
      await handleRedirect();
      await accessToken();
    } catch {
      $("login-view").hidden = false;
      return;
    }
    $("app-view").hidden = false;
    const idt = store.getItem("id_token");
    if (idt) $("user-email").textContent = decodeJwt(idt).email || "";
    try {
      const me = await api("GET", "/me");
      $("tab-admin").hidden = !me.admin;
    } catch (e) { toast(e.message, true); }
    loadInstance();
    loadFiles();
  })();
})();

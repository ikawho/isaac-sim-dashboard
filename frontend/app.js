/* Isaac Sim Workspace - frontend without a build step */
(() => {
  "use strict";
  const CFG = window.APP_CONFIG;
  const $ = (id) => document.getElementById(id);
  const { t } = window.i18n;   // dashboard texts in German / English (i18n.js); server texts stay English

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
  // In-page "click twice" confirmation. Browser confirm() dialogs are blocked inside LMS frames (OLAT),
  // so the first click turns the button into a confirm button for 5 seconds; the second click runs the action.
  function confirmClick(btn, action, hint, label = t("confirm.delete")) {
    if (btn.dataset.armed) {
      clearTimeout(btn._disarm); delete btn.dataset.armed; btn.textContent = btn._label;
      action();
      return;
    }
    btn._label = btn.textContent;
    btn.dataset.armed = "1";
    btn.textContent = label;
    if (hint) toast(hint);
    btn._disarm = setTimeout(() => { delete btn.dataset.armed; btn.textContent = btn._label; }, 5000);
  }
  const num = (n, digits) => n.toLocaleString(i18n.locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const fmtSize = (b) => b < 1024 ? `${b} B` : b < 1048576 ? `${num(b / 1024, 1)} KB`
    : b < 1073741824 ? `${num(b / 1048576, 1)} MB` : `${num(b / 1073741824, 2)} GB`;
  const fmtDate = (s) => new Date(s).toLocaleString(i18n.locale(), { dateStyle: "short", timeStyle: "short" });
  const el = (tag, props = {}, ...kids) => {
    const n = Object.assign(document.createElement(tag), props);
    kids.flat().forEach((k) => n.append(k));
    return n;
  };
  // ------------------------------------------------------------ Login (own form + Cognito SRP)
  // Cognito's hosted sign-in pages send "X-Frame-Options: DENY" and cannot be shown inside a frame
  // (e.g. the OLAT course page), so the dashboard signs in through the Cognito API itself.
  // Tokens live in sessionStorage (gone when the tab is closed), like before.
  const Cog = window.AmazonCognitoIdentity;
  const userPool = new Cog.CognitoUserPool({ UserPoolId: CFG.userPoolId, ClientId: CFG.clientId, Storage: sessionStorage });
  let pendingUser = null;   // user in the middle of a challenge (new password / MFA) or a password reset

  // Cognito error code -> text key
  const AUTH_ERRORS = {
    NotAuthorizedException: "auth.wrongCredentials",
    UserNotFoundException: "auth.wrongCredentials",
    PasswordResetRequiredException: "auth.resetRequired",
    InvalidPasswordException: "auth.pwPolicy",
    InvalidParameterException: "auth.checkInput",
    CodeMismatchException: "auth.codeWrong",
    ExpiredCodeException: "auth.codeExpired",
    LimitExceededException: "auth.tooMany",
    TooManyRequestsException: "auth.tooMany",
    TooManyFailedAttemptsException: "auth.tooManyFailed",
  };
  function authError(e) {
    const m = (e && e.message) || "";
    if (e && e.i18n) return t(e.i18n);
    if (/temporary password has expired/i.test(m)) return t("auth.tempExpired");
    if (/disabled/i.test(m)) return t("auth.disabled");
    if (/password.*(policy|conform|long enough)/i.test(m)) return t("auth.pwPolicy");
    const key = AUTH_ERRORS[e && (e.code || e.name)];
    return key ? t(key) : m || t("auth.failed");   // unknown Cognito messages stay as sent (English)
  }
  // error carrying a text key, so authError() shows it in the current language
  const keyError = (key) => Object.assign(new Error(t(key)), { i18n: key });

  function authMsg(text, kind = "error") {
    const m = $("auth-msg");
    m.textContent = text || "";
    m.className = `auth-msg ${kind}`;
    m.hidden = !text;
  }
  function showStep(step) {
    document.querySelectorAll("form.auth").forEach((f) => (f.hidden = f.dataset.step !== step));
    authMsg("");
    const first = document.querySelector(`form.auth[data-step="${step}"] input`);
    if (first) first.focus();
  }
  document.querySelectorAll("form.auth [data-goto]").forEach((b) => (b.onclick = () => {
    if (b.dataset.goto === "forgot") $("fp-email").value = $("si-email").value;
    showStep(b.dataset.goto);
  }));

  // runs a form's async action with its submit button disabled
  function onSubmit(id, fn) {
    $(id).onsubmit = async (e) => {
      e.preventDefault();
      const btn = e.target.querySelector("button[type=submit]");
      btn.disabled = true;
      try { await fn(); } catch (err) { authMsg(authError(err)); } finally { btn.disabled = false; }
    };
  }
  const normEmail = (v) => v.trim().toLowerCase();
  const cognitoUser = (email) => new Cog.CognitoUser({ Username: email, Pool: userPool, Storage: sessionStorage });

  // Callbacks shared by sign-in, new-password and MFA steps
  function authCallbacks(resolve, reject) {
    return {
      onSuccess: (session) => resolve(session),
      onFailure: (err) => reject(err),
      newPasswordRequired: () => { showStep("newpw"); resolve(null); },
      totpRequired: () => { showStep("mfa"); resolve(null); },
      mfaRequired: () => reject(keyError("auth.smsUnsupported")),
      mfaSetup: () => reject(keyError("auth.mfaSetup")),
    };
  }
  const finish = (session) => { if (session) enterApp(session); };

  onSubmit("f-signin", () => new Promise((resolve, reject) => {
    pendingUser = cognitoUser(normEmail($("si-email").value));
    pendingUser.authenticateUser(new Cog.AuthenticationDetails({
      Username: normEmail($("si-email").value), Password: $("si-password").value,
    }), authCallbacks(resolve, reject));
  }).then(finish));

  onSubmit("f-newpw", () => {
    if ($("np-password").value !== $("np-password2").value) throw keyError("auth.pwMismatch");
    return new Promise((resolve, reject) => {
      pendingUser.completeNewPasswordChallenge($("np-password").value, {}, authCallbacks(resolve, reject));
    }).then(finish);
  });

  onSubmit("f-mfa", () => new Promise((resolve, reject) => {
    pendingUser.sendMFACode($("mfa-code").value.trim(), authCallbacks(resolve, reject), "SOFTWARE_TOKEN_MFA");
  }).then(finish));

  let codeDest = null;   // masked email the reset code was sent to
  const renderCodeSent = () => ($("rs-sent").textContent = t("reset.sent", { dest: codeDest || t("reset.yourEmail") }));

  onSubmit("f-forgot", () => new Promise((resolve, reject) => {
    pendingUser = cognitoUser(normEmail($("fp-email").value));
    pendingUser.forgotPassword({
      onSuccess: resolve,
      onFailure: reject,
      inputVerificationCode: (data) => {
        codeDest = (data && data.CodeDeliveryDetails && data.CodeDeliveryDetails.Destination) || null;
        renderCodeSent();
        showStep("reset");
        resolve();
      },
    });
  }));

  onSubmit("f-reset", () => new Promise((resolve, reject) => {
    pendingUser.confirmPassword($("rs-code").value.trim(), $("rs-password").value, {
      onSuccess: () => {
        $("si-email").value = pendingUser.getUsername();
        $("si-password").value = "";
        showStep("signin");
        authMsg(t("reset.done"), "info");
        resolve();
      },
      onFailure: reject,
    });
  }));

  // Current session; the SDK refreshes expired tokens with the refresh token automatically.
  function currentSession() {
    return new Promise((resolve, reject) => {
      const u = userPool.getCurrentUser();
      if (!u) return reject(new Error("not-logged-in"));
      u.getSession((err, session) => (err || !session || !session.isValid()
        ? reject(err || new Error("not-logged-in")) : resolve(session)));
    });
  }

  async function accessToken() {
    try {
      return (await currentSession()).getAccessToken().getJwtToken();
    } catch (e) {
      location.reload();   // session gone (e.g. refresh token expired) -> back to the sign-in form
      throw new Error(t("auth.sessionExpired"));
    }
  }

  function logout() {
    const u = userPool.getCurrentUser();
    if (u) u.signOut();
    sessionStorage.clear();
    location.reload();
  }

  // ------------------------------------------------------------ API
  async function api(method, path, body) {
    const r = await fetch(CFG.apiUrl + path, {
      method,
      headers: { Authorization: `Bearer ${await accessToken()}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || data.message || t("error.status", { status: r.status }));
    return data;
  }

  async function busy(btn, fn) {
    btn.disabled = true;
    try { await fn(); } catch (e) { toast(e.message, true); } finally { btn.disabled = false; }
  }

  // ------------------------------------------------------------ Machine
  const PHASES = ["booting", "setup", "pulling", "syncing", "building", "starting", "ready"];
  const STATES = ["none", "requesting", "pending", "running", "stopping", "stopped", "shutting-down"];
  const stateText = (st) => (STATES.includes(st) ? t(`state.${st}`) : st);
  let pollTimer;
  let lastInstance = null;   // last status, re-rendered when the language changes
  let maxHours = 8;          // auto-stop limit shown in the help text

  // s.detail, s.lastError and search.detail come from the server and stay English
  function renderInstance(s) {
    lastInstance = s;
    const st = s.state;
    let text = stateText(st), dot = "", detail = "";
    if (st === "running") {
      if (s.phase === "ready") { text = t("state.ready"); dot = "ok"; detail = t("detail.ready"); }
      else if (s.phase === "error") { text = t("state.failed"); dot = "err"; detail = s.detail; }
      else {
        text = t("state.settingUp"); dot = "busy"; detail = s.detail;
        const mins = s.phaseSince ? Math.floor((Date.now() / 1000 - s.phaseSince) / 60) : null;
        if (mins != null && mins >= 1) detail += t("detail.minutes", { n: mins });
        // normal durations: pulling ~10-20 min on first start, starting up to ~30 min (shader cache)
        const limit = { pulling: 40, starting: 45 }[s.phase] || 20;
        if (mins != null && mins >= limit) {
          dot = "err";
          detail += t("detail.tooLong");
        }
      }
    } else if (st === "requesting") {
      dot = "busy"; detail = `${s.detail || t("detail.searching")} …`;
    } else if (st === "pending" || st === "stopping" || st === "shutting-down") {
      dot = "busy";
      detail = st === "pending" ? t("detail.pending") : "";
    } else if (st === "stopped") {
      detail = t("detail.stopped");
    } else if (st === "none") {
      detail = t("detail.none");
    }
    if (s.lastError && (st === "none" || st === "stopped")) {
      text = t("state.failed"); dot = "err"; detail = s.lastError;
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
    $("f-hours").textContent = s.runningHours != null ? `${s.runningHours.toLocaleString(i18n.locale())} h` : "–";
    if (s.maxSessionHours) { maxHours = s.maxSessionHours; $("f-max").textContent = maxHours; }

    const transitional = ["requesting", "pending", "stopping", "shutting-down"].includes(st) || (st === "running" && s.phase !== "ready" && s.phase !== "error");
    clearTimeout(pollTimer);
    pollTimer = setTimeout(loadInstance, transitional ? 8000 : 45000);
  }

  // ------------------------------------------------------------ GPU capacity search (type x zone grid)
  // result -> pill style; labels are "result.<result>", tooltips "resultHelp.<result>" in i18n.js
  const RESULT = {
    trying: "busy", launched: "ok", no_capacity: "err", not_offered: "",
    quota: "warn", skipped_quota: "", not_tried: "", error: "err",
  };
  const RESULT_HELP = ["quota", "skipped_quota", "not_offered", "not_tried"];

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
    $("s-when").textContent = running ? t("search.runningNow")
      : t("search.at", { time: new Date(search.ts * 1000).toLocaleTimeString(i18n.locale(), { timeStyle: "short" }) });

    // summary line: which machine was found and whether it is connected (Isaac Sim stream ready)
    let summary;
    if (running) {
      const tried = Object.values(search.attempts || {}).filter((a) => a.result !== "trying").length;
      summary = t("search.checked", { n: tried, m: search.types.length * zones.length });
    } else if (search.phase === "error") {
      summary = t("search.failed", { detail: search.detail });
    } else {
      const hit = Object.entries(search.attempts || {}).find(([, a]) => a.result === "launched");
      const [type, zone] = hit ? hit[0].split("|") : [s.instanceType, s.zone];
      const conn = s.state === "running" && s.phase === "ready" ? t("search.connReady")
        : s.state === "running" ? t("search.connStarting")
        : s.state === "pending" ? t("search.connBooting")
        : t("search.connNone");
      summary = t("search.started", { type: type || "?", zone: zone || "?", conn });
    }
    $("s-summary").textContent = summary;

    // zone headers: "eu-central-1a" -> "Zone 1a" (full name as tooltip)
    $("s-head").replaceChildren(el("tr", {}, el("th", { textContent: t("search.type") }),
      ...zones.map((z) => el("th", { textContent: t("search.zone", { z: z.split("-").pop() }), title: z }))));
    $("s-body").replaceChildren(...search.types.map((type) => el("tr", {},
      el("td", {}, el("code", { textContent: type })),
      ...zones.map((z) => {
        const a = (search.attempts || {})[`${type}|${z}`];
        const known = a && a.result in RESULT;
        const [label, cls] = a ? (known ? [t(`result.${a.result}`), RESULT[a.result]] : [a.code || a.result, "err"])
          : [running ? t("search.waiting") : t("search.notTried"), ""];
        const help = a && RESULT_HELP.includes(a.result) ? t(`resultHelp.${a.result}`) : "";
        return el("td", {}, el("span", { className: `pill ${cls}`, textContent: label, title: (a && a.code) || help }));
      }),
    )));
  }

  async function loadLog() {
    try {
      const { log, updated } = await api("GET", "/instance/log");
      const pre = $("log-text");
      const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
      pre.textContent = log || t("log.empty");
      if (atBottom) pre.scrollTop = pre.scrollHeight;
      $("log-when").textContent = updated
        ? t("log.updated", { time: new Date(updated).toLocaleTimeString(i18n.locale(), { timeStyle: "medium" }) }) : "";
    } catch (e) { $("log-text").textContent = e.message; }
  }
  $("m-log").addEventListener("toggle", (e) => { if (e.target.open) loadLog(); });

  async function loadInstance() {
    try { renderInstance(await api("GET", "/instance")); }
    catch (e) { toast(e.message, true); clearTimeout(pollTimer); pollTimer = setTimeout(loadInstance, 30000); }
  }

  $("btn-start").onclick = (e) => busy(e.currentTarget, async () => {
    renderInstance(await api("POST", "/instance/start"));
    toast(t("toast.requested"));
  });
  $("btn-stop").onclick = (e) => busy(e.currentTarget, async () => {
    renderInstance(await api("POST", "/instance/stop"));
    toast(t("toast.stopping"));
  });
  $("btn-allow").onclick = (e) => busy(e.currentTarget, async () => {
    renderInstance(await api("POST", "/instance/allow-ip"));
    toast(t("toast.ipSwitched"));
  });
  $("btn-terminate").onclick = (e) => {
    const btn = e.currentTarget;
    confirmClick(btn, () => busy(btn, async () => {
      await api("POST", "/instance/terminate");
      toast(t("toast.deleting"));
      setTimeout(loadInstance, 2000);
    }), t("confirm.machineHint"), t("confirm.machine"));
  };

  // ------------------------------------------------------------ My files
  let lastFiles = null;   // last file list, re-rendered when the language changes
  async function loadFiles() {
    try { renderFiles((await api("GET", "/files")).files); }
    catch (e) { toast(e.message, true); }
  }
  function renderFiles(files) {
    lastFiles = files;
    $("file-list").replaceChildren(...files.map((f) => el("tr", {},
        el("td", { className: "name", textContent: f.name }),
        el("td", { className: "num", textContent: fmtSize(f.size) }),
        el("td", { textContent: fmtDate(f.lastModified) }),
        el("td", { className: "row-actions" },
          el("button", { className: "link", textContent: t("files.download"), onclick: () => download(f.name) }),
          el("button", { className: "link danger", textContent: t("files.delete"),
            onclick: (e) => confirmClick(e.currentTarget, () => removeFile(f.name), t("files.deleteHint", { name: f.name })) })),
    )));
    $("files-empty").hidden = files.length > 0;
  }

  async function download(name) {
    try {
      const { url } = await api("GET", `/files/download-url?name=${encodeURIComponent(name)}`);
      location.assign(url);
    } catch (e) { toast(e.message, true); }
  }

  async function removeFile(name) {
    try { await api("DELETE", `/files?name=${encodeURIComponent(name)}`); toast(t("files.deleted")); loadFiles(); }
    catch (e) { toast(e.message, true); }
  }

  function putWithProgress(url, file, onProgress) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("PUT", url);
      x.upload.onprogress = (ev) => ev.lengthComputable && onProgress(ev.loaded / ev.total);
      x.onload = () => (x.status < 300 ? resolve() : reject(new Error(t("files.uploadFailed", { status: x.status }))));
      x.onerror = () => reject(new Error(t("files.uploadNetwork")));
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
        if (file.size > 5 * 1024 ** 3) throw new Error(t("files.tooLarge"));
        const { url } = await api("POST", "/files/upload-url", { name });
        await putWithProgress(url, file, (p) => (pct.textContent = `${Math.round(p * 100)} %`));
        row.remove();
      } catch (e) {
        pct.textContent = t("files.error");
        toast(`${name}: ${e.message}`, true);
      }
    }
    loadFiles();
  }

  $("file-input").onchange = (e) => { upload([...e.target.files]); e.target.value = ""; };
  const dz = $("dropzone");
  ["dragenter", "dragover"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => dz.addEventListener(ev, (e) => { e.preventDefault(); dz.classList.remove("over"); }));
  dz.addEventListener("drop", (e) => upload([...e.dataTransfer.files]));

  // ------------------------------------------------------------ Admin
  const INST_PILL = { running: "ok", pending: "busy", stopping: "busy" };

  async function loadAdmin() {
    try {
      const [{ users }, { instances }] = await Promise.all([api("GET", "/admin/users"), api("GET", "/admin/instances")]);
      $("user-list").replaceChildren(...users.map((u) => el("tr", {},
        el("td", { className: "name", textContent: u.email || u.username }),
        el("td", { textContent: t(!u.enabled ? "admin.disabled" : u.status === "FORCE_CHANGE_PASSWORD" ? "admin.invited" : "admin.active") }),
        el("td", { textContent: t(u.admin ? "admin.administrator" : "admin.user") }),
        el("td", {}, el("span", { className: `pill ${INST_PILL[u.instance] || ""}`, textContent: stateText(u.instance) })),
        el("td", { className: "row-actions" },
          el("button", { className: "link", textContent: t(u.admin ? "admin.removeAdmin" : "admin.makeAdmin"),
            onclick: () => adminAction("POST", u, { admin: !u.admin }) }),
          el("button", { className: "link", textContent: t(u.enabled ? "admin.disable" : "admin.enable"),
            onclick: () => adminAction("POST", u, { enabled: !u.enabled }) }),
          el("button", { className: "link danger", textContent: t("admin.delete"), onclick: (e) => confirmClick(e.currentTarget, () => adminAction("DELETE", u),
            t("admin.userHint", { email: u.email || u.username })) })),
      )));
      $("instance-list").replaceChildren(...instances.map((i) => el("tr", {},
        el("td", { className: "name", textContent: i.ownerEmail || i.owner }),
        el("td", {}, el("span", { className: `pill ${INST_PILL[i.state] || ""}`,
          textContent: stateText(i.state) + (i.phase && i.phase !== "ready" ? ` (${i.phase})` : "") })),
        el("td", { textContent: i.instanceType }),
        el("td", { className: "num", textContent: i.runningHours != null ? i.runningHours.toLocaleString(i18n.locale()) : "–" }),
        el("td", {}, el("code", { textContent: i.publicIp || "–" })),
        el("td", { className: "row-actions" },
          i.state === "running" ? el("button", { className: "link", textContent: t("admin.stop"), onclick: () => instAction(i.instanceId, "stop") }) : "",
          el("button", { className: "link danger", textContent: t("admin.delete"), onclick: (e) => confirmClick(e.currentTarget, () => instAction(i.instanceId, "terminate"),
            t("admin.machineHint")) })),
      )));
      $("inst-empty").hidden = instances.length > 0;
    } catch (e) { toast(e.message, true); }
  }

  async function adminAction(method, u, body) {
    try {
      await api(method, `/admin/users/${encodeURIComponent(u.username)}`, body);
      toast(t("admin.saved"));
      loadAdmin();
    } catch (e) { toast(e.message, true); }
  }
  async function instAction(id, action) {
    try { await api("POST", `/admin/instances/${id}/${action}`); toast(t("admin.done")); loadAdmin(); }
    catch (e) { toast(e.message, true); }
  }

  $("form-user").onsubmit = async (e) => {
    e.preventDefault();
    const btn = e.submitter;
    busy(btn, async () => {
      await api("POST", "/admin/users", { email: $("new-email").value, admin: $("new-admin").checked });
      toast(t("admin.inviteSent"));
      e.target.reset();
      loadAdmin();
    });
  };

  // ------------------------------------------------------------ Navigation
  document.querySelectorAll(".tab").forEach((tab) => (tab.onclick = () => {
    document.querySelectorAll(".tab").forEach((x) => x.setAttribute("aria-selected", x === tab));
    const v = tab.dataset.view;
    $("view-workspace").hidden = v !== "workspace";
    $("view-admin").hidden = v !== "admin";
    if (v === "admin") loadAdmin();
  }));

  // ------------------------------------------------------------ Language
  // Re-render everything in the new language without a reload.
  function applyLanguage() {
    document.querySelectorAll("[data-armed]").forEach((b) => {   // cancel pending "click again" confirmations
      clearTimeout(b._disarm); delete b.dataset.armed; b.textContent = b._label;
    });
    i18n.applyStatic({ max: maxHours });
    if (!$("rs-sent").closest("form").hidden) renderCodeSent();
    authMsg("");
    if (lastInstance) renderInstance(lastInstance);
    if (lastFiles) renderFiles(lastFiles);
    if ($("m-log").open) loadLog();
    if (!$("view-admin").hidden) loadAdmin();
  }
  i18n.onChange = applyLanguage;
  i18n.applyStatic({ max: maxHours });
  $("log-text").textContent = t("log.loading");

  // ------------------------------------------------------------ Start
  $("btn-logout").onclick = logout;

  async function enterApp(session) {
    document.querySelectorAll("form.auth input").forEach((i) => (i.value = ""));
    $("login-view").hidden = true;
    $("app-view").hidden = false;
    $("user-email").textContent = session.getIdToken().payload.email || "";
    try {
      const me = await api("GET", "/me");
      $("tab-admin").hidden = !me.admin;
    } catch (e) { toast(e.message, true); }
    loadInstance();
    loadFiles();
  }

  (async function init() {
    let session;
    try {
      session = await currentSession();
    } catch {
      $("login-view").hidden = false;
      showStep("signin");
      return;
    }
    enterApp(session);
  })();
})();

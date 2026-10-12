/**
 * SmartSlate backend v2 - Google Apps Script + Google Sheets.
 *
 * Everything goes through one POST endpoint with an "action":
 *   sync                  student devices send answers, nickname changes and account deletions
 *   teacherStatus         does a teacher account exist? (returns its public salt)
 *   teacherSetup          create the teacher account (first time only)
 *   teacherChangePassword change the teacher password
 *   class                 read class results (teacher password required)
 *
 * The teacher password is never stored. The browser turns it into a 64-character hash,
 * and this script stores only a SHA-256 of that hash in Script Properties (not in the Sheet).
 */
const TOPICS  = ["int", "fra", "equ", "are", "rat"];
const HEADERS = ["key", "sid", "name", "qid", "topic", "ok", "ts"];
const PROPS   = PropertiesService.getScriptProperties();
const MAX_FAILS = 5;          // wrong teacher passwords allowed ...
const FAIL_WINDOW_S = 600;    // ... within this many seconds before a lockout

/* ---------- helpers ---------- */
function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName("Attempts");
  if (!sh) { sh = ss.insertSheet("Attempts"); sh.appendRow(HEADERS); sh.setFrozenRows(1); }
  return sh;
}
function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
// Stops a nickname like "=HYPERLINK(...)" from running as a spreadsheet formula.
function safeText_(s) {
  s = String(s || "").slice(0, 20);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}
function sha256Hex_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8)
    .map(function (b) { return ("0" + (b & 0xff).toString(16)).slice(-2); }).join("");
}
const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;

function teacher_() { return { salt: PROPS.getProperty("T_SALT"), verifier: PROPS.getProperty("T_VERIFIER") }; }

// Checks the teacher hash and slows down guessing: 5 wrong tries locks it for 10 minutes.
function auth_(th) {
  const cache = CacheService.getScriptCache();
  const fails = Number(cache.get("tfails") || 0);
  if (fails >= MAX_FAILS) return { ok: false, status: 429, error: "Too many wrong tries. Wait 10 minutes." };
  const t = teacher_();
  if (!t.verifier) return { ok: false, status: 404, error: "No teacher account yet" };
  if (typeof th === "string" && HEX64.test(th) && sha256Hex_(th) === t.verifier) {
    cache.remove("tfails");
    return { ok: true };
  }
  cache.put("tfails", String(fails + 1), FAIL_WINDOW_S);
  return { ok: false, status: 401, error: "Wrong teacher password" };
}

/* ---------- routes ---------- */
function doPost(e) {
  var req;
  try { req = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: "Bad JSON" }); }
  if (Array.isArray(req)) req = { action: "sync", records: req };   // older app versions
  switch (req && req.action) {
    case "sync": return sync_(req);
    case "teacherStatus": { var t = teacher_(); return json_({ ok: true, exists: !!t.verifier, salt: t.salt || null }); }
    case "teacherSetup": return teacherSetup_(req);
    case "teacherChangePassword": return teacherChange_(req);
    case "class": return class_(req);
    default: return json_({ ok: false, error: "Unknown action" });
  }
}
function doGet() { return json_({ ok: true, service: "SmartSlate sync is running" }); }

function teacherSetup_(req) {
  const lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    if (teacher_().verifier) return json_({ ok: false, status: 409, error: "A teacher account already exists" });
    const code = PROPS.getProperty("SETUP_CODE");            // optional: add this Script property to restrict setup
    if (code && req.code !== code) return json_({ ok: false, status: 403, error: "Wrong setup code" });
    if (!HEX32.test(req.salt || "") || !HEX64.test(req.th || "")) return json_({ ok: false, error: "Bad data" });
    PROPS.setProperty("T_SALT", req.salt);
    PROPS.setProperty("T_VERIFIER", sha256Hex_(req.th));
    return json_({ ok: true });
  } finally { lock.releaseLock(); }
}

function teacherChange_(req) {
  const a = auth_(req.th);
  if (!a.ok) return json_(a);
  if (!HEX32.test(req.newSalt || "") || !HEX64.test(req.newTh || "")) return json_({ ok: false, error: "Bad data" });
  PROPS.setProperty("T_SALT", req.newSalt);
  PROPS.setProperty("T_VERIFIER", sha256Hex_(req.newTh));
  return json_({ ok: true });
}

function class_(req) {
  const a = auth_(req.th);
  if (!a.ok) return json_(a);
  const sh = sheet_(), last = sh.getLastRow();
  const rows = last > 1 ? sh.getRange(2, 1, last - 1, HEADERS.length).getValues() : [];
  const by = {};
  rows.forEach(function (r) {
    const sid = r[1], topic = r[4], ok = r[5] === true || r[5] === "TRUE";
    const s = by[sid] || (by[sid] = { id: sid, name: "Student", topics: {} });
    s.name = String(r[2]).replace(/^'/, "") || s.name;
    const t = s.topics[topic] || (s.topics[topic] = { c: 0, n: 0 });
    t.n++; if (ok) t.c++;
  });
  return json_({ ok: true, students: Object.keys(by).map(function (k) { return by[k]; }) });
}

function sync_(req) {
  const records = Array.isArray(req.records) ? req.records : [];
  const renames = Array.isArray(req.renames) ? req.renames : [];
  const deletes = Array.isArray(req.deletes) ? req.deletes : [];
  if (records.length > 500 || renames.length > 50 || deletes.length > 50) return json_({ ok: false, error: "Too much data" });

  const validSid = function (s) { return typeof s === "string" && s.length > 0 && s.length <= 40; };
  const lock = LockService.getScriptLock(); lock.waitLock(20000);   // one write at a time
  try {
    const sh = sheet_();
    var last = sh.getLastRow();
    var data = last > 1 ? sh.getRange(2, 1, last - 1, HEADERS.length).getValues() : [];

    // 1) accounts deleted on a device: remove their rows
    const del = {}; deletes.forEach(function (s) { if (validSid(s)) del[s] = true; });
    // 2) nickname changes: rename every row of that student
    const ren = {}; renames.forEach(function (r) { if (r && validSid(r.sid)) ren[r.sid] = safeText_(r.name); });
    var changed = false;
    if (Object.keys(del).length) {
      const n = data.length; data = data.filter(function (r) { return !del[r[1]]; });
      if (data.length !== n) changed = true;
    }
    if (Object.keys(ren).length) {
      data.forEach(function (r) { if (ren[r[1]] !== undefined && r[2] !== ren[r[1]]) { r[2] = ren[r[1]]; changed = true; } });
    }
    if (changed && last > 1) {
      sh.getRange(2, 1, last - 1, HEADERS.length).clearContent();
      if (data.length) sh.getRange(2, 1, data.length, HEADERS.length).setValues(data);
      last = data.length + 1;
    }

    // 3) new answers (the same answer sent twice is only saved once)
    const seen = {}; data.forEach(function (r) { seen[r[0]] = true; });
    const rows = [];
    records.forEach(function (a) {
      const valid = a && validSid(a.sid) && typeof a.qid === "string" && a.qid.length <= 10 &&
                    TOPICS.indexOf(a.topic) !== -1 && typeof a.ok === "boolean" && isFinite(a.ts);
      if (!valid || del[a.sid]) return;
      const key = a.sid + "|" + a.qid + "|" + a.ts;
      if (seen[key]) return;
      seen[key] = true;
      rows.push([key, a.sid, safeText_(a.name), a.qid, a.topic, a.ok, a.ts]);
    });
    if (rows.length) sh.getRange(last + 1, 1, rows.length, HEADERS.length).setValues(rows);
    return json_({ ok: true, saved: rows.length });
  } finally { lock.releaseLock(); }
}

const express = require("express");
const crypto = require("crypto");
const app = express();

app.use(express.json({ limit: "1mb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(200);
  next();
});

// ─── In-memory state ────────────────────────────────────────────────────────
const rooms   = new Map(); // code → RoomState
const reports = [];        // { id, roomCode, reporter, reason, ts }

function newRoom(code) {
  const salt = crypto.randomBytes(32).toString("base64");
  return {
    code,
    salt,
    members:   new Map(), // sessionId → { codename, joinedAt }
    messages:  [],        // { id, sessionId, codename, ciphertext, iv, sig, ts }
    signals:   new Map(), // sessionId → [pending WebRTC signals]
    createdAt: Date.now(),
  };
}

function roomView(room) {
  return {
    code:     room.code,
    salt:     room.salt,
    members:  [...room.members.values()],
    messages: room.messages.slice(-200),
  };
}

function purgeEmpty() {
  for (const [code, room] of rooms) {
    if (room.members.size === 0 && Date.now() - room.createdAt > 5000) {
      rooms.delete(code);
    }
  }
}
setInterval(purgeEmpty, 30_000);

// ─── Codenames ───────────────────────────────────────────────────────────────
const ADJ  = ["Phantom","Cipher","Shadow","Rogue","Stealth","Ghost","Binary","Neon","Dark","Void","Null","Hex","Crypt","Zero","Nano","Vector"];
const NOUN = ["Wolf","Fox","Raven","Shark","Viper","Hawk","Lynx","Cobra","Eagle","Puma","Panther","Falcon","Dragon","Hydra","Specter","Wraith"];

function genCodename() {
  const a = ADJ[Math.floor(Math.random() * ADJ.length)];
  const n = NOUN[Math.floor(Math.random() * NOUN.length)];
  const d = String(Math.floor(Math.random() * 900) + 100);
  return `${a}${n}${d}`;
}

function genCode() {
  const seg = () => crypto.randomBytes(2).toString("hex").toUpperCase();
  return `${seg()}-${seg()}-${seg()}-${seg()}`;
}

// ─── Room Endpoints ──────────────────────────────────────────────────────────

// POST /api/room/join  { code? }
app.post("/api/room/join", (req, res) => {
  let { code } = req.body || {};

  if (code) {
    code = code.trim().toUpperCase();
    if (!/^[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}-[A-F0-9]{4}$/.test(code)) {
      return res.status(400).json({ error: "Invalid room code format." });
    }
    if (!rooms.has(code)) {
      return res.status(404).json({ error: "Room not found." });
    }
  } else {
    code = genCode();
    while (rooms.has(code)) code = genCode();
    rooms.set(code, newRoom(code));
  }

  const room      = rooms.get(code);
  const sessionId = crypto.randomBytes(16).toString("hex");
  const codename  = genCodename();

  room.members.set(sessionId, { codename, joinedAt: Date.now() });

  // system join message (plaintext — no encryption for system events)
  room.messages.push({
    id:       crypto.randomUUID(),
    type:     "system",
    text:     `${codename} joined the room.`,
    ts:       Date.now(),
  });

  res.json({ sessionId, codename, ...roomView(room) });
});

// POST /api/room/leave  { code, sessionId }
app.post("/api/room/leave", (req, res) => {
  const { code, sessionId } = req.body || {};
  const room = rooms.get(code);
  if (!room) return res.json({ ok: true });

  const member = room.members.get(sessionId);
  if (member) {
    room.members.delete(sessionId);
    room.messages.push({
      id:   crypto.randomUUID(),
      type: "system",
      text: `${member.codename} left the room.`,
      ts:   Date.now(),
    });
  }

  if (room.members.size === 0) {
    rooms.delete(code);
  }

  res.json({ ok: true });
});

// POST /api/room/message  { code, sessionId, ciphertext, iv, sig }
app.post("/api/room/message", (req, res) => {
  const { code, sessionId, ciphertext, iv, sig } = req.body || {};
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: "Room not found." });

  const member = room.members.get(sessionId);
  if (!member) return res.status(401).json({ error: "Not a room member." });

  if (!ciphertext || !iv || !sig) {
    return res.status(400).json({ error: "Missing encrypted payload." });
  }

  const msg = {
    id:         crypto.randomUUID(),
    type:       "message",
    sessionId,
    codename:   member.codename,
    ciphertext,
    iv,
    sig,
    ts:         Date.now(),
  };

  room.messages.push(msg);
  if (room.messages.length > 500) room.messages.splice(0, 100);

  res.json({ ok: true, messageId: msg.id });
});

// GET /api/room/:code?sessionId=&after=
app.get("/api/room/:code", (req, res) => {
  const { code } = req.params;
  const { sessionId, after } = req.query;
  const room = rooms.get(code?.toUpperCase());

  if (!room) return res.status(404).json({ error: "Room not found." });
  if (!room.members.has(sessionId)) {
    return res.status(401).json({ error: "Not a room member." });
  }

  const afterTs = parseInt(after, 10) || 0;
  const newMsgs = room.messages.filter(m => m.ts > afterTs);

  res.json({
    code:     room.code,
    salt:     room.salt,
    members:  [...room.members.values()],
    messages: newMsgs,
  });
});

// ─── WebRTC Signaling ────────────────────────────────────────────────────────

// POST /api/room/signal  { code, sessionId, targetId, signal }
app.post("/api/room/signal", (req, res) => {
  const { code, sessionId, targetId, signal } = req.body || {};
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ error: "Room not found." });
  if (!room.members.has(sessionId)) return res.status(401).json({ error: "Unauthorised." });

  if (!room.signals.has(targetId)) room.signals.set(targetId, []);
  room.signals.get(targetId).push({ from: sessionId, signal, ts: Date.now() });

  res.json({ ok: true });
});

// GET /api/room/signal/poll?code=&sessionId=
app.get("/api/room/signal/poll", (req, res) => {
  const { code, sessionId } = req.query;
  const room = rooms.get(code?.toUpperCase());
  if (!room) return res.status(404).json({ error: "Room not found." });

  const pending = room.signals.get(sessionId) || [];
  room.signals.set(sessionId, []);
  res.json({ signals: pending });
});

// ─── Reports ─────────────────────────────────────────────────────────────────

// POST /api/reports/submit  { code, reporter, reason }
app.post("/api/reports/submit", (req, res) => {
  const { code, reporter, reason } = req.body || {};
  if (!code || !reason) return res.status(400).json({ error: "code and reason required." });

  reports.push({
    id:       crypto.randomUUID(),
    roomCode: code,
    reporter: reporter || "Anonymous",
    reason:   String(reason).slice(0, 1000),
    ts:       Date.now(),
    reviewed: false,
  });

  res.json({ ok: true });
});

// ─── Admin ───────────────────────────────────────────────────────────────────
const ADMIN_KEY = process.env.ADMIN_KEY || "changeme-admin-key";

function authAdmin(req, res) {
  const key = req.headers["authorization"]?.replace("Bearer ", "");
  if (key !== ADMIN_KEY) {
    res.status(401).json({ error: "Invalid admin key." });
    return false;
  }
  return true;
}

// POST /api/admin/login  { key }
app.post("/api/admin/login", (req, res) => {
  const { key } = req.body || {};
  if (key === ADMIN_KEY) {
    res.json({ ok: true, token: ADMIN_KEY });
  } else {
    res.status(401).json({ error: "Invalid key." });
  }
});

// GET /api/admin/reports
app.get("/api/admin/reports", (req, res) => {
  if (!authAdmin(req, res)) return;
  res.json({ reports: reports.slice(-100).reverse() });
});

// GET /api/admin/rooms
app.get("/api/admin/rooms", (req, res) => {
  if (!authAdmin(req, res)) return;
  const summary = [...rooms.values()].map(r => ({
    code:      r.code,
    members:   r.members.size,
    messages:  r.messages.length,
    createdAt: r.createdAt,
  }));
  res.json({ rooms: summary });
});

// DELETE /api/admin/room/:code
app.delete("/api/admin/room/:code", (req, res) => {
  if (!authAdmin(req, res)) return;
  rooms.delete(req.params.code?.toUpperCase());
  res.json({ ok: true });
});

// POST /api/admin/report/:id/resolve
app.post("/api/admin/report/:id/resolve", (req, res) => {
  if (!authAdmin(req, res)) return;
  const r = reports.find(x => x.id === req.params.id);
  if (r) r.reviewed = true;
  res.json({ ok: true });
});

module.exports = app;

require("dotenv").config();
const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const bcrypt = require("bcryptjs");
const Database = require("better-sqlite3");
const multer = require("multer");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

const dataDir = path.join(__dirname, "data");
const uploadDir = path.join(__dirname, "uploads");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(uploadDir, { recursive: true });
const db = new Database(path.join(dataDir, "hamresan.sqlite"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
 id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL,
 display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
 is_admin INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS conversations (
 id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL,
 title TEXT, created_by INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS members (
 conversation_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
 PRIMARY KEY(conversation_id,user_id)
);
CREATE TABLE IF NOT EXISTS messages (
 id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER NOT NULL,
 sender_id INTEGER NOT NULL, body TEXT NOT NULL DEFAULT '',
 attachment_name TEXT, attachment_path TEXT, attachment_mime TEXT,
 created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id,id);
`);

const sessionMiddleware = session({
  store: new SQLiteStore({ db: "sessions.sqlite", dir: dataDir, concurrentDB: true }),
  secret: process.env.SESSION_SECRET || "development-only-change-this-secret",
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 7*24*60*60*1000 }
});

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "1mb" }));
app.use(sessionMiddleware);
app.use("/api/login", rateLimit({ windowMs: 15*60*1000, limit: 30, standardHeaders: true, legacyHeaders: false }));
app.use(express.static(path.join(__dirname, "public")));


const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadDir),
    filename: (_req, file, cb) => {
      const safe = path.basename(file.originalname).replace(/[^a-zA-Z0-9._-]/g, "_").slice(-100);
      cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}-${safe}`);
    }
  }),
  limits: { fileSize: (Number(process.env.MAX_UPLOAD_MB) || 50) * 1024 * 1024 }
});

function auth(req, res, next) {
  if (!req.session.user) return res.status(401).json({ error: "ابتدا وارد حساب شوید." });
  next();
}
function memberOf(conversationId, userId) {
  return !!db.prepare("SELECT 1 FROM members WHERE conversation_id=? AND user_id=?").get(conversationId, userId);
}
function safeUser(row) {
  return { id: row.id, username: row.username, displayName: row.display_name, isAdmin: !!row.is_admin };
}
function conversationFor(userId, id) {
  return db.prepare(`
    SELECT c.* FROM conversations c JOIN members m ON m.conversation_id=c.id
    WHERE c.id=? AND m.user_id=?
  `).get(id, userId);
}
function emitToConversation(conversationId, event, payload) {
  const rows = db.prepare("SELECT user_id FROM members WHERE conversation_id=?").all(conversationId);
  for (const row of rows) io.to(`user:${row.user_id}`).emit(event, payload);
}

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: "نام کاربری و رمز عبور لازم است." });
  const user = db.prepare("SELECT * FROM users WHERE username=?").get(String(username).trim().toLowerCase());
  if (!user || !(await bcrypt.compare(String(password), user.password_hash))) {
    return res.status(401).json({ error: "نام کاربری یا رمز عبور اشتباه است." });
  }
  req.session.regenerate(err => {
    if (err) return res.status(500).json({ error: "خطا در ورود." });
    req.session.user = safeUser(user);
    res.json({ user: req.session.user });
  });
});
app.post("/api/logout", auth, (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get("/api/me", (req, res) => res.json({ user: req.session.user || null }));

app.get("/api/users", auth, (req, res) => {
  const users = db.prepare("SELECT id,username,display_name,is_admin FROM users WHERE id<>? ORDER BY id").all(req.session.user.id);
  res.json(users.map(safeUser));
});

app.get("/api/conversations", auth, (req, res) => {
  const rows = db.prepare(`
    SELECT c.id,c.type,c.title,c.created_at,
      (SELECT body FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1) last_message,
      (SELECT display_name FROM users WHERE id=(SELECT sender_id FROM messages WHERE conversation_id=c.id ORDER BY id DESC LIMIT 1)) last_sender
    FROM conversations c JOIN members m ON m.conversation_id=c.id
    WHERE m.user_id=? ORDER BY c.id DESC
  `).all(req.session.user.id);
  const result = rows.map(c => {
    if (c.type === "direct") {
      const other = db.prepare(`SELECT u.id,u.username,u.display_name FROM members m JOIN users u ON u.id=m.user_id
        WHERE m.conversation_id=? AND u.id<>?`).get(c.id, req.session.user.id);
      return { ...c, title: other?.display_name || "گفت‌وگوی خصوصی", otherUser: other };
    }
    return c;
  });
  res.json(result);
});

app.post("/api/direct", auth, (req, res) => {
  const otherId = Number(req.body.userId);
  if (!db.prepare("SELECT id FROM users WHERE id=?").get(otherId)) return res.status(404).json({ error: "کاربر پیدا نشد." });
  if (otherId === req.session.user.id) return res.status(400).json({ error: "نمی‌توانید با خودتان گفت‌وگو بسازید." });
  let conv = db.prepare(`SELECT c.id FROM conversations c
    JOIN members a ON a.conversation_id=c.id AND a.user_id=?
    JOIN members b ON b.conversation_id=c.id AND b.user_id=?
    WHERE c.type='direct' LIMIT 1`).get(req.session.user.id, otherId);
  if (!conv) {
    const info = db.prepare("INSERT INTO conversations(type,created_by) VALUES('direct',?)").run(req.session.user.id);
    const id = info.lastInsertRowid;
    const add = db.prepare("INSERT INTO members(conversation_id,user_id) VALUES(?,?)");
    add.run(id, req.session.user.id); add.run(id, otherId);
    conv = { id };
  }
  res.json({ id: conv.id });
});

app.post("/api/groups", auth, (req, res) => {
  const title = String(req.body.title || "").trim().slice(0, 60);
  const ids = [...new Set((Array.isArray(req.body.userIds) ? req.body.userIds : []).map(Number).filter(Number.isInteger))];
  if (!title) return res.status(400).json({ error: "نام گروه را وارد کنید." });
  const info = db.prepare("INSERT INTO conversations(type,title,created_by) VALUES('group',?,?)").run(title, req.session.user.id);
  const id = info.lastInsertRowid;
  const add = db.prepare("INSERT OR IGNORE INTO members(conversation_id,user_id) VALUES(?,?)");
  add.run(id, req.session.user.id);
  for (const uid of ids) if (db.prepare("SELECT id FROM users WHERE id=?").get(uid)) add.run(id, uid);
  res.json({ id });
});

app.get("/api/conversations/:id/messages", auth, (req, res) => {
  const id = Number(req.params.id);
  if (!conversationFor(req.session.user.id, id)) return res.status(403).json({ error: "دسترسی ندارید." });
  const messages = db.prepare(`SELECT m.id,m.conversation_id,m.body,m.attachment_name,m.attachment_path,m.attachment_mime,m.created_at,
    u.id sender_id,u.display_name sender_name FROM messages m JOIN users u ON u.id=m.sender_id
    WHERE m.conversation_id=? ORDER BY m.id DESC LIMIT 100`).all(id).reverse();
  res.json(messages);
});

app.post("/api/conversations/:id/messages", auth, upload.single("file"), (req, res) => {
  const id = Number(req.params.id);
  if (!conversationFor(req.session.user.id, id)) return res.status(403).json({ error: "دسترسی ندارید." });
  const body = String(req.body.body || "").trim().slice(0, 5000);
  const file = req.file;
  if (!body && !file) return res.status(400).json({ error: "پیام خالی است." });
  const info = db.prepare(`INSERT INTO messages(conversation_id,sender_id,body,attachment_name,attachment_path,attachment_mime)
    VALUES(?,?,?,?,?,?)`).run(id, req.session.user.id, body, file?.originalname || null, file ? `/media/${file.filename}` : null, file?.mimetype || null);
  const message = db.prepare(`SELECT m.id,m.conversation_id,m.body,m.attachment_name,m.attachment_path,m.attachment_mime,m.created_at,
    u.id sender_id,u.display_name sender_name FROM messages m JOIN users u ON u.id=m.sender_id WHERE m.id=?`).get(info.lastInsertRowid);
  emitToConversation(id, "message:new", message);
  res.json(message);
});
app.get("/media/:filename", auth, (req, res) => {
  const filename = path.basename(req.params.filename);
  const storedPath = `/media/${filename}`;
  const attachment = db.prepare(`SELECT conversation_id FROM messages WHERE attachment_path=?`).get(storedPath);
  if (!attachment || !memberOf(attachment.conversation_id, req.session.user.id)) {
    return res.status(403).send("دسترسی ندارید.");
  }
  res.sendFile(path.join(uploadDir, filename), err => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.post("/api/change-password", auth, async (req, res) => {
  const password = String(req.body.password || "");
  if (password.length < 10) return res.status(400).json({ error: "رمز جدید باید حداقل ۱۰ نویسه داشته باشد." });
  const hash = await bcrypt.hash(password, 12);
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hash, req.session.user.id);
  res.json({ ok: true });
});

io.engine.use(sessionMiddleware);
io.use((socket, next) => socket.request.session?.user ? next() : next(new Error("unauthorized")));
io.on("connection", socket => {
  const user = socket.request.session.user;
  socket.join(`user:${user.id}`);
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, () => console.log(`Hamresan is running on port ${port}`));

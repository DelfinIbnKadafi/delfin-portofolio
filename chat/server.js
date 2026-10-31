require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
const { rateLimit } = require("express-rate-limit");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

const PORT = Number(process.env.PORT || 3000);
const OWNER_USERNAME = process.env.OWNER_USERNAME || "";
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || "";
const SESSION_SECRET = process.env.SESSION_SECRET || "";
const TRUST_PROXY_HOPS = Number(process.env.TRUST_PROXY || 0);
const HOST = process.env.HOST || "0.0.0.0";
const ALLOWED_ORIGINS = (process.env.CHAT_ORIGINS || "")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);
const DATA_FILE = path.resolve(
  process.env.CHAT_DATA_FILE || path.join(__dirname, "data", "chat.json")
);
const OWNER_ROOM = "owners";
const TOKEN_ISSUER = "delfin-chat";
const TOKEN_AUDIENCE = "delfin-chat-client";
const MAX_MESSAGE_LENGTH = 2000;
const MAX_HISTORY = 200;
const MAX_CONVERSATIONS = 200;

function requireConfig() {
  const problems = [];

  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    problems.push("PORT must be a valid TCP port.");
  }
  if (OWNER_USERNAME.length < 2 || OWNER_USERNAME.length > 64) {
    problems.push("OWNER_USERNAME must be between 2 and 64 characters.");
  }
  if (SESSION_SECRET.length < 32 || SESSION_SECRET === "replace-with-a-random-secret-at-least-32-characters-long") {
    problems.push("Set SESSION_SECRET to a unique random value of at least 32 characters.");
  }
  if (ALLOWED_ORIGINS.length === 0) {
    problems.push("Set CHAT_ORIGINS to the website's allowed origin(s).");
  }
  if (!Number.isInteger(TRUST_PROXY_HOPS) || TRUST_PROXY_HOPS < 0) {
    problems.push("TRUST_PROXY must be a non-negative number of trusted proxy hops.");
  }
  if (problems.length > 0) {
    throw new Error(`Invalid chat configuration:\n- ${problems.join("\n- ")}`);
  }
}

requireConfig();

const allowedOrigins = new Set(
  ALLOWED_ORIGINS.map(origin => {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !["http:", "https:"].includes(parsed.protocol)) {
      throw new Error(`CHAT_ORIGINS entries must be plain HTTP(S) origins: ${origin}`);
    }
    return parsed.origin;
  })
);

let store = { visitors: [], messages: [] };
let writeQueue = Promise.resolve();

function persistStore() {
  const write = writeQueue.then(async () => {
    const temporaryFile = `${DATA_FILE}.${process.pid}.tmp`;
    await fs.mkdir(path.dirname(DATA_FILE), { recursive: true });
    await fs.writeFile(temporaryFile, JSON.stringify(store), { mode: 0o600 });
    await fs.rename(temporaryFile, DATA_FILE);
  });
  writeQueue = write.catch(error => {
    console.error("Chat storage write failed:", error);
  });
  return write;
}

function safeEqual(actual, expected) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  return actualBuffer.length === expectedBuffer.length
    && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

function signToken(payload, expiresIn) {
  return jwt.sign(payload, SESSION_SECRET, {
    algorithm: "HS256",
    audience: TOKEN_AUDIENCE,
    expiresIn,
    issuer: TOKEN_ISSUER
  });
}

function verifyToken(token) {
  return jwt.verify(token, SESSION_SECRET, {
    algorithms: ["HS256"],
    audience: TOKEN_AUDIENCE,
    issuer: TOKEN_ISSUER
  });
}

function findVisitor(id) {
  return store.visitors.find(visitor => visitor.id === id);
}

function listConversationMessages(id) {
  return store.messages
    .filter(message => message.conversationId === id)
    .slice(-MAX_HISTORY);
}

function summarizeConversation(visitor) {
  const lastMessage = store.messages
    .filter(message => message.conversationId === visitor.id)
    .at(-1);
  return {
    id: visitor.id,
    name: visitor.name,
    updatedAt: lastMessage?.createdAt || visitor.createdAt,
    lastMessage: lastMessage?.body || ""
  };
}

function conversationSummaries() {
  return store.visitors
    .map(summarizeConversation)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, MAX_CONVERSATIONS);
}

function acknowledge(callback, response) {
  if (typeof callback === "function") callback(response);
}

async function loadStore() {
  try {
    const contents = await fs.readFile(DATA_FILE, "utf8");
    const parsed = JSON.parse(contents);

    if (!Array.isArray(parsed.visitors) || !Array.isArray(parsed.messages)) {
      throw new Error("Chat data file must contain visitors and messages arrays.");
    }

    store = parsed;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await persistStore();
  }
}

const app = express();
app.disable("x-powered-by");
if (TRUST_PROXY_HOPS > 0) app.set("trust proxy", TRUST_PROXY_HOPS);
app.use((request, response, next) => {
  const origin = request.get("origin");

  if (origin && !allowedOrigins.has(origin)) {
    response.status(403).json({ error: "This website is not allowed to use the chat." });
    return;
  }

  if (origin) {
    response.set("Access-Control-Allow-Origin", origin);
    response.set("Vary", "Origin");
    response.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.set("Access-Control-Allow-Headers", "Content-Type");
  }

  if (request.method === "OPTIONS") {
    response.sendStatus(204);
    return;
  }

  next();
});
app.use(express.json({ limit: "10kb", strict: true }));
app.use((request, response, next) => {
  response.set("X-Content-Type-Options", "nosniff");
  response.set("Referrer-Policy", "no-referrer");
  response.set("Cache-Control", "no-store");
  next();
});

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 8,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many sign-in attempts. Please try again later." }
});
const visitorLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Too many new chats. Please try again later." }
});

app.get("/health", (_request, response) => {
  response.json({ status: "ok" });
});

app.post("/api/visitor-session", visitorLimiter, async (request, response, next) => {
  const name = typeof request.body?.name === "string" ? request.body.name.trim() : "";

  if (
    name.length < 2 ||
    name.length > 40 ||
    /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    response.status(400).json({ error: "Please enter a name between 2 and 40 characters." });
    return;
  }

  try {
    const visitor = {
      id: crypto.randomUUID(),
      name,
      createdAt: new Date().toISOString()
    };
    store.visitors.push(visitor);
    await persistStore();

    response.status(201).json({
      token: signToken({ role: "visitor", name, sub: visitor.id }, "30d"),
      name
    });

    io.to(OWNER_ROOM).emit("conversation:updated", summarizeConversation(visitor));
  } catch (error) {
    next(error);
  }
});

app.post("/api/owner/login", loginLimiter, (request, response) => {
  const username = typeof request.body?.username === "string" ? request.body.username : "";
  const password = typeof request.body?.password === "string" ? request.body.password : "";

  const usernameMatches = safeEqual(username, OWNER_USERNAME);
  const passwordMatches = safeEqual(password, OWNER_PASSWORD);

  if (!usernameMatches || !passwordMatches) {
    response.status(401).json({ error: "Incorrect username or password." });
    return;
  }

  response.json({
    token: signToken({ role: "owner", name: OWNER_USERNAME, sub: OWNER_USERNAME }, "8h"),
    expiresIn: 8 * 60 * 60
  });
});

app.use((error, _request, response, _next) => {
  console.error("Chat HTTP request failed:", error);
  response.status(500).json({ error: "The chat service encountered an error." });
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: [...allowedOrigins],
    methods: ["GET", "POST"]
  },
  maxHttpBufferSize: 20_000
});

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (typeof token !== "string") throw new Error("unauthorized");

    const claims = verifyToken(token);
    if (claims.role === "owner" && claims.sub === OWNER_USERNAME) {
      socket.data.role = "owner";
      socket.data.conversations = new Set();
      next();
      return;
    }

    if (claims.role === "visitor" && typeof claims.sub === "string" && findVisitor(claims.sub)) {
      socket.data.role = "visitor";
      socket.data.visitorId = claims.sub;
      socket.data.visitorName = findVisitor(claims.sub).name;
      next();
      return;
    }

    throw new Error("unauthorized");
  } catch {
    next(new Error("unauthorized"));
  }
});

io.on("connection", socket => {
  if (socket.data.role === "owner") {
    socket.join(OWNER_ROOM);
    return;
  }

  const conversationId = socket.data.visitorId;
  socket.join(`conversation:${conversationId}`);
  socket.emit("conversation:history", listConversationMessages(conversationId));
});

io.on("connection", socket => {
  if (socket.data.role !== "owner") return;

  socket.on("owner:conversations", callback => {
    acknowledge(callback, { ok: true, conversations: conversationSummaries() });
  });

  socket.on("owner:join", (payload, callback) => {
    const conversationId = payload?.conversationId;
    const visitor = typeof conversationId === "string" ? findVisitor(conversationId) : null;

    if (!visitor) {
      acknowledge(callback, { ok: false, error: "Conversation not found." });
      return;
    }

    socket.join(`conversation:${conversationId}`);
    socket.data.conversations.add(conversationId);
    acknowledge(callback, {
      ok: true,
      messages: listConversationMessages(conversationId)
    });
  });
});

io.on("connection", socket => {
  socket.on("message:send", async (payload, callback) => {
    const body = typeof payload?.body === "string" ? payload.body.trim() : "";
    const now = Date.now();
    const recentMessages = (socket.data.messageTimes || []).filter(time => now - time < 10_000);
    socket.data.messageTimes = recentMessages;

    if (recentMessages.length >= 8) {
      acknowledge(callback, { ok: false, error: "Please wait a moment before sending another message." });
      return;
    }
    if (body.length === 0 || body.length > MAX_MESSAGE_LENGTH) {
      acknowledge(callback, { ok: false, error: "Messages must contain 1 to 2,000 characters." });
      return;
    }

    const conversationId = socket.data.role === "visitor"
      ? socket.data.visitorId
      : payload?.conversationId;
    const visitor = typeof conversationId === "string" ? findVisitor(conversationId) : null;

    if (
      !visitor ||
      (socket.data.role === "owner" && !socket.data.conversations.has(conversationId))
    ) {
      acknowledge(callback, { ok: false, error: "Open a conversation before sending a reply." });
      return;
    }

    socket.data.messageTimes.push(now);
    const message = {
      id: crypto.randomUUID(),
      conversationId,
      sender: socket.data.role,
      body,
      createdAt: new Date(now).toISOString()
    };
    store.messages.push(message);
    visitor.updatedAt = message.createdAt;

    try {
      await persistStore();
      io.to(`conversation:${conversationId}`).emit("message:new", message);
      io.to(OWNER_ROOM).emit("conversation:updated", summarizeConversation(visitor));
      acknowledge(callback, { ok: true });
    } catch {
      acknowledge(callback, { ok: false, error: "Your message could not be saved. Please try again." });
    }
  });
});

async function start() {
  await loadStore();
  server.listen(PORT, HOST, () => {
    const displayHost = HOST === "0.0.0.0" ? "localhost" : HOST;
    console.log(`Delfin chat server is running at http://${displayHost}:${PORT} (bound to ${HOST})`);
  });
}

start().catch(error => {
  console.error("Chat server startup failed:", error);
  process.exitCode = 1;
});

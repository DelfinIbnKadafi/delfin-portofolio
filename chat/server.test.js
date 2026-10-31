const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const { io } = require("socket.io-client");

const OWNER_USERNAME = "Delfin";
const OWNER_PASSWORD = "test-owner-password-long-enough";
const SESSION_SECRET = "test-session-secret-for-local-chat-only-123456";
const SERVER_PATH = path.join(__dirname, "server.js");

let dataDirectory;
let dataFile;
let serverPort;
let serverProcess;
let serverOutput = "";
let sockets = [];

async function findAvailablePort() {
  const listener = http.createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const { port } = listener.address();
  await new Promise((resolve, reject) => {
    listener.close(error => error ? reject(error) : resolve());
  });
  return port;
}

async function startServer() {
  serverProcess = spawn(process.execPath, [SERVER_PATH], {
    env: {
      ...process.env,
      CHAT_DATA_FILE: dataFile,
      CHAT_ORIGINS: "http://localhost",
      HOST: "127.0.0.1",
      OWNER_PASSWORD,
      OWNER_USERNAME,
      PORT: String(serverPort),
      SESSION_SECRET,
      TRUST_PROXY: "0"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  serverOutput = "";
  serverProcess.stdout.setEncoding("utf8").on("data", chunk => {
    serverOutput += chunk;
  });
  serverProcess.stderr.setEncoding("utf8").on("data", chunk => {
    serverOutput += chunk;
  });

  const address = `http://127.0.0.1:${serverPort}`;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Chat server exited before starting:\n${serverOutput}`);
    }

    try {
      const response = await fetch(`${address}/health`);
      if (response.ok) return address;
    } catch {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  throw new Error(`Chat server did not start:\n${serverOutput}`);
}

async function stopServer() {
  for (const socket of sockets) socket.disconnect();
  sockets = [];

  if (!serverProcess || serverProcess.exitCode !== null) return;
  const exited = once(serverProcess, "exit");
  serverProcess.kill();
  await exited;
  serverProcess = null;
}

async function connectSocket(address, token) {
  const socket = io(address, {
    autoConnect: false,
    auth: { token },
    transports: ["websocket"]
  });
  sockets.push(socket);

  const [messages] = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for visitor history.")), 3000);
    socket.once("connect_error", error => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("conversation:history", history => {
      clearTimeout(timer);
      resolve([history]);
    });
    socket.connect();
  });
  return { socket, messages };
}

function emitAck(socket, event, payload) {
  return new Promise((resolve, reject) => {
    const acknowledge = (error, response) => {
      if (error) {
        reject(new Error(`Timed out waiting for ${event} acknowledgement.`));
      } else {
        resolve(response);
      }
    };

    if (payload === undefined) {
      socket.timeout(3000).emit(event, acknowledge);
    } else {
      socket.timeout(3000).emit(event, payload, acknowledge);
    }
  });
}

before(async () => {
  dataDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "delfin-chat-test-"));
  dataFile = path.join(dataDirectory, "chat.json");
  serverPort = await findAvailablePort();
  await startServer();
});

after(async () => {
  await stopServer();
  if (dataDirectory) {
    await fs.rm(dataDirectory, { recursive: true, force: true });
  }
});

test("private conversations, owner replies, and messages survive a restart", async () => {
  const baseUrl = `http://127.0.0.1:${serverPort}`;

  const invalidName = await fetch(`${baseUrl}/api/visitor-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: " " })
  });
  assert.equal(invalidName.status, 400);

  const failedLogin = await fetch(`${baseUrl}/api/owner/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: OWNER_USERNAME, password: "wrong-password" })
  });
  assert.equal(failedLogin.status, 401);

  const createVisitor = async name => {
    const response = await fetch(`${baseUrl}/api/visitor-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    assert.equal(response.status, 201);
    return response.json();
  };
  const aliceSession = await createVisitor("Alice");
  const bobSession = await createVisitor("Bob");

  const ownerLogin = await fetch(`${baseUrl}/api/owner/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: OWNER_USERNAME, password: OWNER_PASSWORD })
  });
  assert.equal(ownerLogin.status, 200);
  const { token: ownerToken } = await ownerLogin.json();

  const alice = await connectSocket(baseUrl, aliceSession.token);
  const bob = await connectSocket(baseUrl, bobSession.token);
  const owner = io(baseUrl, {
    autoConnect: false,
    auth: { token: ownerToken },
    transports: ["websocket"]
  });
  sockets.push(owner);
  const ownerConnected = once(owner, "connect");
  owner.connect();
  await ownerConnected;

  const listed = await emitAck(owner, "owner:conversations");
  assert.equal(listed.ok, true);
  assert.deepEqual(new Set(listed.conversations.map(item => item.name)), new Set(["Alice", "Bob"]));

  const aliceConversation = listed.conversations.find(item => item.name === "Alice");
  const opened = await emitAck(owner, "owner:join", { conversationId: aliceConversation.id });
  assert.equal(opened.ok, true);
  assert.deepEqual(opened.messages, []);

  const visitorMessage = once(owner, "message:new");
  const visitorAck = await emitAck(alice.socket, "message:send", { body: "Hello Delfin" });
  assert.equal(visitorAck.ok, true);
  assert.equal((await visitorMessage)[0].body, "Hello Delfin");

  const reply = once(alice.socket, "message:new");
  const ownerAck = await emitAck(owner, "message:send", {
    body: "Hello Alice",
    conversationId: aliceConversation.id
  });
  assert.equal(ownerAck.ok, true);
  assert.equal((await reply)[0].body, "Hello Alice");

  assert.deepEqual(bob.messages, []);
  const rejectedJoin = await emitAck(owner, "owner:join", { conversationId: "unknown-conversation" });
  assert.equal(rejectedJoin.ok, false);

  await stopServer();
  await startServer();

  const restoredAlice = await connectSocket(`http://127.0.0.1:${serverPort}`, aliceSession.token);
  assert.deepEqual(
    restoredAlice.messages.map(message => message.body),
    ["Hello Delfin", "Hello Alice"]
  );
});

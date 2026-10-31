const $ = selector => document.querySelector(selector);
const CHAT_CONFIG = window.DELFIN_CHAT_CONFIG || {};
const CHAT_SERVER_URL = (CHAT_CONFIG.serverUrl || window.location.origin)
  .replace(/\/+$/, "");
const VISITOR_TOKEN_KEY = "delfin.chat.visitorToken";
const VISITOR_NAME_KEY = "delfin.chat.visitorName";
const OWNER_TOKEN_KEY = "delfin.chat.ownerToken";

const visitorView = $("#visitor-view");
const ownerView = $("#owner-view");
const statusLabel = $("#connection-status");
const visitorStartForm = $("#visitor-start-form");
const visitorChat = $("#visitor-chat");
const visitorTranscript = $("#visitor-transcript");
const visitorMessageForm = $("#visitor-message-form");
const ownerInbox = $("#owner-inbox");
const ownerTranscript = $("#owner-transcript");
const ownerMessageForm = $("#owner-message-form");

let socket = null;
let activeConversationId = null;
let conversations = [];

function setStatus(message, online = false) {
  statusLabel.textContent = message;
  statusLabel.classList.toggle("is-online", online);
}

function showError(selector, message) {
  $(selector).textContent = message;
}

function updateOwnerPasswordVisibility() {
  const isOwner = $("#visitor-name").value.trim().toLowerCase() === "delfin";
  $("#owner-password-field").hidden = !isOwner;
  $("#visitor-start-button").textContent = isOwner ? "Sign in" : "Start chatting";
  $("#visitor-start-note").textContent = isOwner
    ? "Enter the owner password to open your private inbox."
    : "Just your name is enough to get started.";

  if (!isOwner) {
    $("#owner-password").value = "";
    showError("#owner-login-error", "");
  }
}

function formatTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function addMessage(container, message, mine) {
  const bubble = document.createElement("div");
  bubble.className = `chat-bubble${mine ? " is-mine" : ""}`;
  bubble.append(document.createTextNode(message.body));

  const time = document.createElement("small");
  time.textContent = formatTime(message.createdAt);
  bubble.append(time);
  container.append(bubble);
  container.scrollTop = container.scrollHeight;
}

function renderMessages(container, messages, ownSender) {
  container.replaceChildren();

  if (messages.length === 0) {
    const empty = document.createElement("p");
    empty.className = "chat-empty";
    empty.textContent = "Send a message to start the conversation.";
    container.append(empty);
    return;
  }

  messages.forEach(message => {
    addMessage(container, message, message.sender === ownSender);
  });
}

function connect(token, role) {
  if (socket) {
    socket.disconnect();
  }

  socket = window.io(CHAT_SERVER_URL, {
    autoConnect: false,
    auth: { token },
    transports: ["websocket", "polling"]
  });

  socket.on("connect", () => {
    setStatus("Connected", true);
    if (role === "owner") {
      requestConversations();
    }
  });

  socket.on("disconnect", () => setStatus("Reconnecting…"));
  socket.on("connect_error", error => {
    setStatus("Unable to connect");
    if (role === "visitor" && error.message === "unauthorized") {
      localStorage.removeItem(VISITOR_TOKEN_KEY);
      localStorage.removeItem(VISITOR_NAME_KEY);
      visitorStartForm.hidden = false;
      visitorChat.hidden = true;
      showError("#visitor-start-error", "Your saved chat expired. Please start again.");
    } else if (role === "owner" && error.message === "unauthorized") {
      sessionStorage.removeItem(OWNER_TOKEN_KEY);
      ownerView.hidden = true;
      ownerInbox.hidden = true;
      visitorView.hidden = false;
      visitorStartForm.hidden = false;
      visitorChat.hidden = true;
      $("#visitor-name").value = "Delfin";
      updateOwnerPasswordVisibility();
      showError("#owner-login-error", "Your sign-in expired. Please sign in again.");
    } else {
      showError(
        role === "owner" ? "#owner-login-error" : "#visitor-message-error",
        "Chat is temporarily unavailable. Please try again in a moment."
      );
    }
  });

  socket.on("conversation:history", messages => {
    if (role === "visitor") {
      renderMessages(visitorTranscript, messages, "visitor");
    }
  });

  socket.on("message:new", message => {
    if (role === "visitor") {
      addMessage(visitorTranscript, message, message.sender === "visitor");
    } else if (message.conversationId === activeConversationId) {
      addMessage(ownerTranscript, message, message.sender === "owner");
    }
  });

  socket.on("conversation:updated", summary => {
    if (role !== "owner") return;
    conversations = [
      summary,
      ...conversations.filter(item => item.id !== summary.id)
    ];
    renderConversationList();
  });

  socket.connect();
}

function requestConversations() {
  if (!socket?.connected) return;

  socket.emit("owner:conversations", response => {
    if (!response?.ok) {
      showError("#owner-login-error", response?.error || "Could not load conversations.");
      return;
    }

    conversations = response.conversations;
    renderConversationList();
  });
}

function renderConversationList() {
  const list = $("#conversation-list");
  list.replaceChildren();

  if (conversations.length === 0) {
    const empty = document.createElement("p");
    empty.className = "chat-empty";
    empty.textContent = "No conversations yet.";
    list.append(empty);
    return;
  }

  conversations.forEach(conversation => {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute(
      "aria-current",
      conversation.id === activeConversationId ? "true" : "false"
    );

    const name = document.createElement("strong");
    name.textContent = conversation.name;

    const preview = document.createElement("small");
    preview.textContent = conversation.lastMessage || "New conversation";

    const time = document.createElement("small");
    time.textContent = formatTime(conversation.updatedAt);
    button.append(name, preview, time);
    button.addEventListener("click", () => openConversation(conversation.id));
    list.append(button);
  });
}

function openConversation(conversationId) {
  if (!socket?.connected) return;

  socket.emit("owner:join", { conversationId }, response => {
    if (!response?.ok) {
      showError("#owner-message-error", response?.error || "Could not open this conversation.");
      return;
    }

    activeConversationId = conversationId;
    const conversation = conversations.find(item => item.id === conversationId);
    $("#owner-active-name").textContent = conversation?.name || "Visitor";
    $("#owner-select-prompt").hidden = true;
    $("#owner-active-chat").hidden = false;
    showError("#owner-message-error", "");
    renderMessages(ownerTranscript, response.messages, "owner");
    renderConversationList();
    $("#owner-message").focus();
  });
}

function sendMessage(form, selector, errorSelector, role) {
  form.addEventListener("submit", event => {
    event.preventDefault();
    const input = $(selector);
    const body = input.value.trim();

    if (!body) {
      showError(errorSelector, "Please write a message first.");
      return;
    }

    if (body.length > 2000) {
      showError(errorSelector, "Messages must be 2,000 characters or fewer.");
      return;
    }

    if (!socket?.connected) {
      showError(errorSelector, "Not connected yet. Please try sending again shortly.");
      return;
    }

    const payload = { body };
    if (role === "owner") {
      payload.conversationId = activeConversationId;
    }

    socket.emit("message:send", payload, response => {
      if (!response?.ok) {
        showError(errorSelector, response?.error || "Your message could not be sent.");
        return;
      }

      input.value = "";
      showError(errorSelector, "");
      input.focus();
    });
  });
}

$("#visitor-name").addEventListener("input", updateOwnerPasswordVisibility);

visitorStartForm.addEventListener("submit", async event => {
  event.preventDefault();
  const nameInput = $("#visitor-name");
  const name = nameInput.value.trim();
  showError("#visitor-start-error", "");
  showError("#owner-login-error", "");

  if (name.length < 2 || name.length > 40 || /[\u0000-\u001f\u007f]/u.test(name)) {
    showError("#visitor-start-error", "Please enter a name between 2 and 40 characters.");
    return;
  }

  if (name.toLowerCase() === "delfin") {
    const password = $("#owner-password").value;
    if (!password) {
      showError("#owner-login-error", "Please enter your password.");
      $("#owner-password").focus();
      return;
    }

    await signInOwner("Delfin", password);
    return;
  }

  const button = visitorStartForm.querySelector("button[type=submit]");
  button.disabled = true;

  try {
    const response = await fetch(`${CHAT_SERVER_URL}/api/visitor-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name })
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Could not start your chat.");
    }

    localStorage.setItem(VISITOR_TOKEN_KEY, result.token);
    localStorage.setItem(VISITOR_NAME_KEY, result.name);
    startVisitorChat(result.token, result.name);
  } catch (error) {
    showError("#visitor-start-error", error.message);
  } finally {
    button.disabled = false;
  }
});

async function signInOwner(username, password) {
  const button = visitorStartForm.querySelector("button[type=submit]");
  button.disabled = true;

  try {
    const response = await fetch(`${CHAT_SERVER_URL}/api/owner/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || "Sign in failed.");
    }

    sessionStorage.setItem(OWNER_TOKEN_KEY, result.token);
    $("#owner-password").value = "";
    visitorView.hidden = true;
    ownerView.hidden = false;
    ownerInbox.hidden = false;
    setStatus("Signing in…");
    connect(result.token, "owner");
  } catch (error) {
    showError("#owner-login-error", error.message);
  } finally {
    button.disabled = false;
  }
}

function startVisitorChat(token, name) {
  visitorView.hidden = false;
  ownerView.hidden = true;
  ownerInbox.hidden = true;
  visitorStartForm.hidden = true;
  visitorChat.hidden = false;
  $("#visitor-name-label").textContent = name;
  $("#chat-panel-title").textContent = `Chat with Delfin`;
  connect(token, "visitor");
}

$("#visitor-change-name").addEventListener("click", () => {
  localStorage.removeItem(VISITOR_TOKEN_KEY);
  localStorage.removeItem(VISITOR_NAME_KEY);
  socket?.disconnect();
  socket = null;
  visitorTranscript.replaceChildren();
  visitorChat.hidden = true;
  visitorStartForm.hidden = false;
  $("#visitor-name").value = "";
  updateOwnerPasswordVisibility();
  setStatus("Ready when you are");
  $("#visitor-name").focus();
});

$("#owner-logout").addEventListener("click", () => {
  sessionStorage.removeItem(OWNER_TOKEN_KEY);
  socket?.disconnect();
  socket = null;
  conversations = [];
  activeConversationId = null;
  ownerView.hidden = true;
  ownerInbox.hidden = true;
  visitorView.hidden = false;
  visitorStartForm.hidden = false;
  visitorChat.hidden = true;
  ownerTranscript.replaceChildren();
  $("#owner-active-chat").hidden = true;
  $("#owner-select-prompt").hidden = false;
  $("#visitor-name").value = "";
  updateOwnerPasswordVisibility();
  showError("#owner-login-error", "");
  setStatus("Signed out");
});

sendMessage(visitorMessageForm, "#visitor-message", "#visitor-message-error", "visitor");
sendMessage(ownerMessageForm, "#owner-message", "#owner-message-error", "owner");

setStatus("Ready when you are");

const visitorToken = localStorage.getItem(VISITOR_TOKEN_KEY);
const visitorName = localStorage.getItem(VISITOR_NAME_KEY);
const ownerToken = sessionStorage.getItem(OWNER_TOKEN_KEY);

if (ownerToken) {
  visitorView.hidden = true;
  ownerView.hidden = false;
  ownerInbox.hidden = false;
  setStatus("Connecting…");
  connect(ownerToken, "owner");
} else if (visitorToken && visitorName) {
  startVisitorChat(visitorToken, visitorName);
}

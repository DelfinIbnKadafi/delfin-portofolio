# Delfin Web

Website for Delfin Ibn Kadafi with many thing you can do.

## Live chat

The static welcome and portfolio pages link to the chat in `chat/`. The chat
backend is a separate Node.js service that uses Socket.IO for live updates and
stores conversations in `chat/data/chat.json`.

1. In `chat/`, run `npm install`.
2. Copy `.env.example` to `.env`, keep the owner username as `Delfin`, set a
   strong password,
   and generate a unique `SESSION_SECRET` with
   `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"`.
3. Set `CHAT_ORIGINS` to the exact HTTPS origin(s) serving the website, then run
   `npm start` on a Node.js host with persistent disk storage.
4. Set `serverUrl` in `chat/config.js` to the public HTTPS URL of the Node.js
   service, then deploy the static site.

Typing `Delfin` as the chat name reveals the owner password field. The owner
signs in using the password in `.env`. Never commit `.env`; message history and
login details are private server data.
Run `npm test --prefix chat` to check the private chat, owner replies, and
persistent message history locally.

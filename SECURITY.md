# Security

## What claudraw is, and what it is not

claudraw is a **local development tool**. It starts an HTTP server on `127.0.0.1` that can read and write the project you
point it at, and it runs a real shell (Claude Code or another agent CLI) in a browser terminal. That is by design, and it
means the server must stay on your own machine.

- It binds to `127.0.0.1` only. Do not bind it to `0.0.0.0`, put it behind a reverse proxy, or expose it through a tunnel
  (ngrok, Cloudflare Tunnel, port forwarding, a dev container with a public port, and so on). Anyone who can reach it can run
  commands as you.
- Requests are accepted only with a local `Host` header, and the terminal WebSocket only with a local `Origin`, which blocks
  other web pages and DNS rebinding. Do not weaken these checks (`isLocalRequest` in `server/config.ts`).
- API keys you enter in Settings are stored in `~/.config/canvas/settings.json` with mode 600, outside your projects, and are
  never sent back to the browser.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub's private reporting:
**Security → Report a vulnerability** on https://github.com/andreivasilache/claudraw/security/advisories/new

Include what you found, how to reproduce it, and the version (`canvas --version`). This is a one-person project: I will
answer as soon as I can and credit you in the fix unless you prefer not to be named.

## Supported versions

Only the latest release gets fixes.

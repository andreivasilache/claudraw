# claudraw

Excalidraw canvas + MCP server + agent terminal. Before changing code, read [ROADMAP.md](ROADMAP.md): it has the file map,
the ground rules, what is done and what is open.

- `npm run typecheck` and `npm test` must pass; after a UI change run `npm run build:ui` and commit `dist/`.
- Never edit `.canvas/` data by hand and never test on a user's diagram; use a scratch diagram.
- Only macOS has been tested. Do not claim Linux or Windows work without trying.
- This repo is public: no secrets, no private hostnames or IPs, no personal paths in code, docs or commit messages.

# Roadmap and agent context

Read this before changing anything. It replaces the old `docs/dev/` agent briefs, which were removed from the repository.
Update the lists below when you finish or discover something; add the date.

## What claudraw is

An Excalidraw canvas with an MCP server (so an agent such as Claude Code draws on it), a React UI, and an agent terminal in a
side panel. One Node server (`server/index.ts`, port 8787) serves many projects; each project keeps its data in `.canvas/`.

| File | Role |
|---|---|
| `server/tools.ts` | **All MCP tools** (`defs`), zod schemas, descriptions, the plan gate, argument aliases, server instructions. Two modes: plain (Claude Code) and `?structured` (OpenCode: gate, `userChoice`, output schemas). |
| `server/scene.ts` | The drawing engine: elements, layouts (ELK/dagre), lint, `fixLayout`, arrow routing, history. `mutate(fn, label)` is synchronous and not re-entrant. |
| `server/recommend.ts` | `plan_diagram`: ranks diagram types for a text. `evals/` scores it (`npx tsx evals/run.ts`, `npx tsx evals/examples.ts`). |
| `server/charts.ts`, `stickies.ts`, `export.ts`, `generated.ts` | `add_chart`, `add_sticky_notes`, `export_diagram`, the registry behind `replace` / `get_generated`. |
| `server/llm.ts`, `terminal.ts` | Which agent runs in the panel; the pty behind the browser terminal. |
| `server/migrate.ts`, `init.ts`, `version.ts` | Data-format migrations, `canvas init`, update check. |
| `src/` | The React page (Excalidraw, notes, history, terminal, export menu). `dist/` is its committed build. |

## Ground rules

1. Never edit `.canvas/*.excalidraw`, `notes.json` or `context.json` by hand; change diagrams through the MCP tools.
2. Never test on a user's diagram or on `main`. Call `list_diagrams` first and use a scratch diagram. `undo` restores a mistake.
3. The server has no watch mode: restart `npm start` after a server change; reload the page.
4. `npm run typecheck` and `npm test` after every change. UI change → `npm run build:ui` and commit `dist/`.
5. Match the surrounding style: short names, a one or two line `/** … */` saying *why* above non-trivial functions.
6. A new data-format change that older versions cannot read is a **major** version (see `CHANGELOG.md`) and needs a migration.
7. Do not change the colour rule ("no colour legend → leave boxes uncoloured") or a user's context texts without asking.
8. Keep `templates/CLAUDE.section.md` and the tool instructions in `tools.ts` / `guides.ts` in sync when a tool changes.
9. Do not fine-tune or train a model for diagram choice: it is a deterministic recommender + tool descriptions + examples + evals.

## Done (so you do not redo it)

Diagram-type recommender (`plan_diagram`) and gate; "Use when / Not for" tool descriptions; container hierarchy styles; ELK
layout and obstacle-aware arrow routing; types tree, sequence, cycle, quadrant, mindmap; 52-case eval set; 15 retrievable
examples; screenshot rubric; `find_nodes`; `screenshot: true` on drawing tools; toolsets (`?toolsets=`) and `read_guide`;
conflict detection (`baseRev`); `edit_nodes` and `transform_nodes`; `export_diagram` + Export menu; `replace` / `get_generated`
/ `delete_generated`; `add_chart` (9 types) and `add_sticky_notes`; box `detail` / `inside`; data migrations and `canvas init`.

## Open work (most useful first)

1. **OpenCode / small-model reliability is unverified.** The user reported "many MCP errors" with OpenCode after the slimmed
   instructions; the full text is the default again (`structuredInstructions()` in `guides.ts`, `CANVAS_SLIM_INSTRUCTIONS=1`
   opts into the short one). The real error messages were never seen. A baseline for comparison: one fresh run of a 6-day
   itinerary used 2 turns, 1 tool call, 0 schema errors with the full instructions. Known weak spots from earlier runs: a model
   inventing `userChoice` to pass the gate (now refused in the same run, up to 3 times), a date on a clock axis, unknown note
   kinds (now a plain note), the model never looking at the canvas before drawing.
2. **Things implemented but not seen working in a real browser:** the Export menu's PNG/SVG downloads (the menu itself shows in the UI, `src/ExportMenu.tsx`), and
   `screenshot: true` with a live page (the failure path is tested). Check both on a scratch diagram.
3. **Known small issues:** scatter points at the axis min/max sit on the plot edge (no padding); there is no `chart` kind in
   `recommend.ts` (`Layout` in `context.ts`); sticky colours look brown in the dark theme (export with `darkMode: false` for
   the real colours); undo/delete can leave a box's notes behind (orphans, hidden by `get_notes`); `recommend()` ranks "explain
   the TLS handshake (client sends hello, …)" as architecture instead of sequence. Seen in the README screenshots: the timeline
   axis is labelled 1-9 instead of month names (the tool only takes numbers or dates: accept month names or label the ticks);
   a box's `detail` text can spill over the border when the box is short (Auth service in the architecture example); the flow
   auto-layout can put a decision at the top, out of order, when the chart has back-edges (the agent had to move boxes by hand).
4. **Not tested:** Linux and Windows (only macOS was). `node-pty` is compiled on Linux (needs Python, make, a C++ compiler).
5. **Ideas, not started:** a "Save as example" action in the page (only if evals show retrieval helps the model's choice);
   an end-to-end eval with `claude -p` against a test project (costs tokens); edit-by-find/replace on stored specs (`edits`);
   recommending vLLM `--enable-prefix-caching` in the docs for self-hosted OpenCode setups; publishing to npm (the name
   `claudraw` was free on 2026-11-19; add a `prepublishOnly` check is already in `package.json`).
6. **Repo housekeeping:** `THIRD_PARTY_NOTICES.md` lists the font **Xiaolai** as unverified: confirm its license or remove it
   from `public/fonts`. Add examples and fixtures that are not project-specific (planned).

## How to test

- Unit tests: `npm test` (`test/`). Types: `npm run typecheck`. Recommender: `npx tsx evals/run.ts` (threshold 90%) and
  `npx tsx evals/examples.ts`.
- Live: start the server on a spare port with a throwaway registry (`CANVAS_PORT`, `CANVAS_PROJECTS`, `CANVAS_SETTINGS` point to
  other files), open the page (screenshots and exports need it open), create a scratch diagram, call tools over MCP at
  `http://127.0.0.1:<port>/p/<id>/mcp` (add `?structured` for the OpenCode mode).
- Pure functions (`recommend`, `parseMermaid`) can be called from a scratch `npx tsx` script. Scene functions need a project
  scope: wrap in `runIn(project, fn)`; a blank scene is `{ type: 'excalidraw', version: 2, source: 'canvas', elements: [], appState: {}, files: {} }`.

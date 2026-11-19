# Changelog

Versions follow [semver](https://semver.org). The data in a project's `.canvas/` has its own format number (`FORMAT` in
`server/migrate.ts`, recorded in every data file). **A change to the data format that older versions cannot read is a major
release**; the tool upgrades older projects itself (keeping a backup) and refuses to write to a project written by a newer
one.

## 1.0.0

First public release: installable with `npm i -g git+https://github.com/andreivasilache/claudraw.git#v1.0.0`.

### Added
- `canvas init [dir]` sets up a project (`.canvas/`, the `canvas` entry in `.mcp.json`, a marked section in `CLAUDE.md`,
  the registry); `canvas init --update` refreshes only that section and the canvas fields of `.mcp.json`.
- `canvas --version`, and the installed version (plus a newer tag, when the repo has one) on the project list.
- Versioned data format (**format v1**): every file in `.canvas/` carries a version. Projects from before (format 0) are
  upgraded on first open, with a copy of the old files in `.canvas/.backup-0/`. See the README.
- The working rules for Claude (selection scope, notes, how to draw) are the MCP server's instructions and `read_guide`
  (topic `workflow`), so projects only carry a short, tool-managed `CLAUDE.md` section.
- MIT license, third-party notices, `SECURITY.md`, `CONTRIBUTING.md`, `ROADMAP.md`.

### Changed
- `canvas` serves only the project of the current folder (or `canvas <dir>`); the registry in
  `~/.config/canvas/projects.json` remembers the others, and `canvas --all` shows all of them. In a folder without `.canvas/`,
  `canvas` asks for `canvas init`. No project is adopted automatically: add one with `canvas <dir>`, `canvas init`, or from
  the list page.
- When canvas already runs on the port, a new `canvas` adds its project to that server and exits instead of failing with
  `EADDRINUSE`. A port held by something else gets a clear message.
- `vite`, `@vitejs/plugin-react` and `tsx` are runtime dependencies. `dist/` and `public/fonts/` are committed, so nothing
  has to be built on install.

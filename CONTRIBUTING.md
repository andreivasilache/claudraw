# Contributing

Thanks for looking. claudraw is a small project maintained by one person, so a few ground rules keep it quick for both of us.

- **Open an issue first** for anything bigger than a typo or a small fix, so we agree on the direction before you spend time.
- **Bugs:** say what you ran, what you expected, what happened, your OS, Node version (`node -v`) and `canvas --version`.
  claudraw has only been tested on macOS, so reports from Linux and Windows are very welcome.
- **Security problems:** see [SECURITY.md](SECURITY.md), not a public issue.

## Setup

```sh
git clone https://github.com/andreivasilache/claudraw.git
cd claudraw
npm install
npm run typecheck
npm test
npm start            # server on http://127.0.0.1:8787 (Vite dev UI)
```

Node 20 or newer. `node-pty` ships prebuilt binaries for macOS and Windows; on Linux it is compiled during `npm install`
and needs Python 3, make and a C++ compiler.

## Before you open a pull request

- `npm run typecheck` and `npm test` pass.
- If you change the UI, run `npm run build:ui` and commit `dist/`: the package is installed straight from git, so `dist/` is
  what users get. (`npm version` does this for releases.)
- Keep the style of the surrounding code: short names, a one or two line `/** … */` comment saying *why* above anything
  non-obvious, no comment noise inside functions.
- Never edit `.canvas/` data by hand in a test; use a scratch diagram.
- See [ROADMAP.md](ROADMAP.md) for what is planned and what is known to be unfinished.

## License

By contributing you agree that your contribution is licensed under the MIT license of this project.

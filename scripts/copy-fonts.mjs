// Excalidraw loads its fonts from a CDN by default. Serve them locally so the tool works offline.
// Paths are resolved from this file, not from the working directory, so it also works inside any node_modules.
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// The package does not export its package.json: start from its entry file and go up to the package folder.
let dir = dirname(createRequire(import.meta.url).resolve('@excalidraw/excalidraw'))
while (!(existsSync(join(dir, 'package.json')) && JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).name === '@excalidraw/excalidraw')) {
  const up = dirname(dir)
  if (up === dir) throw new Error('@excalidraw/excalidraw not found')
  dir = up
}
mkdirSync(join(root, 'public'), { recursive: true })
cpSync(join(dir, 'dist', 'prod', 'fonts'), join(root, 'public', 'fonts'), { recursive: true })

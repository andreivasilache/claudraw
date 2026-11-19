import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, resolve } from 'node:path'
import { cur } from './project.ts'

/** An image ready to go into a scene: the Excalidraw file entry and the picture's own size. */
export type LoadedImage = { fileId: string; mimeType: string; dataURL: string; width: number; height: number }

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon', '.avif': 'image/avif' }
// Every version in the history keeps a full copy of the scene, images included.
const MAX_BYTES = 3 * 1024 * 1024

/** The picture's width and height read from its header (PNG, JPEG, GIF, WebP, BMP, SVG); null when it cannot tell. */
function naturalSize(buf: Buffer, mime: string): { width: number; height: number } | null {
  if (mime === 'image/png' && buf.length > 24) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
  if (mime === 'image/gif' && buf.length > 10) return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) }
  if (mime === 'image/bmp' && buf.length > 26) return { width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) }
  if (mime === 'image/jpeg') {
    // The size is in the first start-of-frame marker (C0..CF, except C4, C8 and CC).
    let i = 2
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null
      const m = buf[i + 1]
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) }
      i += 2 + buf.readUInt16BE(i + 2)
    }
    return null
  }
  if (mime === 'image/webp' && buf.length > 30) {
    const kind = buf.toString('ascii', 12, 16)
    if (kind === 'VP8 ') return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff }
    if (kind === 'VP8L') {
      const b = buf.readUInt32LE(21)
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1 }
    }
    if (kind === 'VP8X') return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 }
  }
  if (mime === 'image/svg+xml') {
    const head = buf.toString('utf8', 0, 4000)
    const tag = head.match(/<svg[^>]*>/i)?.[0] ?? ''
    const num = (a: string) => Number(tag.match(new RegExp(`\\s${a}="([\\d.]+)(px)?"`))?.[1])
    const w = num('width'), h = num('height')
    if (w && h) return { width: w, height: h }
    const vb = tag.match(/viewBox="[\d.\-]+[\s,]+[\d.\-]+[\s,]+([\d.]+)[\s,]+([\d.]+)"/)
    if (vb) return { width: Number(vb[1]), height: Number(vb[2]) }
  }
  return null
}

/** A data: URL, an http(s) URL or a file path (relative to the project) as an image the scene can hold. */
export async function loadImage(src: string): Promise<LoadedImage> {
  let buf: Buffer
  let mime: string | undefined
  if (src.startsWith('data:')) {
    const m = src.match(/^data:([^;,]+)(;base64)?,(.*)$/s)
    if (!m) throw new Error('Not a valid data: URL')
    mime = m[1]
    buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]))
  } else if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) throw new Error(`Could not download ${src}: HTTP ${res.status}`)
    buf = Buffer.from(await res.arrayBuffer())
    mime = res.headers.get('content-type')?.split(';')[0].trim() || MIME[extname(new URL(src).pathname).toLowerCase()]
  } else {
    const file = isAbsolute(src) ? src : resolve(cur().root, src)
    buf = await readFile(file)
    mime = MIME[extname(file).toLowerCase()]
  }
  if (!mime?.startsWith('image/')) throw new Error(`${src.slice(0, 80)} is not an image (${mime ?? 'unknown type'})`)
  if (buf.length > MAX_BYTES) throw new Error(`${src.slice(0, 80)} is larger than 3 MB`)
  const size = naturalSize(buf, mime) ?? { width: 400, height: 300 }
  const dataURL = `data:${mime};base64,${buf.toString('base64')}`
  return { fileId: createHash('sha1').update(dataURL).digest('hex'), mimeType: mime, dataURL, ...size }
}

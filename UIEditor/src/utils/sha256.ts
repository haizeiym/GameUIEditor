/** SHA-256 hex；浏览器用 SubtleCrypto，Node 无 subtle 时回退 node:crypto。 */

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0')
  }
  return out
}

export async function sha256Hex(parts: Uint8Array[]): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle) {
    const total = parts.reduce((n, p) => n + p.byteLength, 0)
    const buf = new Uint8Array(total)
    let offset = 0
    for (const p of parts) {
      buf.set(p, offset)
      offset += p.byteLength
    }
    const digest = await subtle.digest('SHA-256', buf)
    return toHex(new Uint8Array(digest))
  }
  const { createHash } = await import('node:crypto')
  const hash = createHash('sha256')
  for (const p of parts) hash.update(p)
  return hash.digest('hex')
}

/** 像素层指纹：宽高 + 未压缩 RGBA（比 PNG 字节更稳，canvas.toBlob 不可复现） */
export async function hashRgba(
  width: number,
  height: number,
  rgba: Uint8Array | Uint8ClampedArray,
): Promise<string> {
  const header = new Uint8Array(8)
  const view = new DataView(header.buffer)
  view.setUint32(0, width, true)
  view.setUint32(4, height, true)
  const pixels =
    rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength)
  return sha256Hex([header, pixels])
}

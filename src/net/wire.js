// Length-prefixed JSON frames over an encrypted Hyperswarm connection.
export const MAX_FRAME_BYTES = 4 * 1024 * 1024

export function encodeFrame (message) {
  const body = Buffer.from(JSON.stringify(message))
  if (body.length > MAX_FRAME_BYTES) throw new Error('frame too large')
  const head = Buffer.allocUnsafe(4)
  head.writeUInt32BE(body.length)
  return Buffer.concat([head, body])
}

export class FrameDecoder {
  constructor (onMessage) {
    this.onMessage = onMessage
    this.buffer = Buffer.alloc(0)
  }

  // Throws on protocol violations; the caller drops the connection.
  push (chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32BE(0)
      if (size > MAX_FRAME_BYTES) throw new Error('oversized frame')
      if (this.buffer.length < 4 + size) return
      const body = this.buffer.subarray(4, 4 + size)
      this.buffer = this.buffer.subarray(4 + size)
      const message = JSON.parse(body.toString('utf8'))
      if (message === null || typeof message !== 'object') throw new Error('bad frame')
      this.onMessage(message)
    }
  }
}

// Is this module the program that was started, rather than something imported?
// Compared through real paths, and case-insensitively on Windows, where the
// same file can be spelled with different drive-letter or directory casing.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export function isMain (metaUrl) {
  if (!process.argv[1]) return false
  try {
    const started = fs.realpathSync(process.argv[1])
    const self = fs.realpathSync(fileURLToPath(metaUrl))
    return process.platform === 'win32' ? started.toLowerCase() === self.toLowerCase() : started === self
  } catch {
    return false
  }
}

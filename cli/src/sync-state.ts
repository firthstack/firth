import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const statePath = (cwd: string) => join(cwd, '.firth', 'sync-state.json')

export function readAuditOffset(cwd: string): number {
  const p = statePath(cwd)
  if (!existsSync(p)) return 0
  try {
    const s = JSON.parse(readFileSync(p, 'utf8'))
    return typeof s?.audit?.offset === 'number' ? s.audit.offset : 0
  } catch { return 0 }
}

export function writeAuditOffset(cwd: string, offset: number, now: string): void {
  mkdirSync(join(cwd, '.firth'), { recursive: true })
  writeFileSync(statePath(cwd), JSON.stringify({ audit: { offset, syncedAt: now } }, null, 2))
}

// Complete (non-blank) lines from `offset` to the last newline boundary.
// `ends[i]` = byte offset just past `lines[i]`; `newOffset` = byte offset past
// the last complete line (incl. any blank lines). A trailing partial line is
// excluded. `offset > byteLength(content)` (truncation) restarts from 0.
export function readNewAuditLines(content: string, offset: number): { lines: string[]; ends: number[]; newOffset: number } {
  const byteLen = Buffer.byteLength(content, 'utf8')
  const start = offset > byteLen ? 0 : offset
  const tail = Buffer.from(content, 'utf8').subarray(start).toString('utf8')
  const lastNl = tail.lastIndexOf('\n')
  if (lastNl < 0) return { lines: [], ends: [], newOffset: start }
  const block = tail.slice(0, lastNl + 1) // complete lines incl. trailing newline
  const raw = block.split('\n')
  if (raw[raw.length - 1] === '') raw.pop() // drop empty tail after the final '\n'
  const lines: string[] = []
  const ends: number[] = []
  let cursor = start
  for (const l of raw) {
    cursor += Buffer.byteLength(l, 'utf8') + 1 // + the newline
    if (l.trim()) { lines.push(l); ends.push(cursor) }
  }
  return { lines, ends, newOffset: cursor }
}

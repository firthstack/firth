export function formatTeardown(t: { destroyed?: string[]; failed?: { kind: string }[] }): string {
  const parts: string[] = []

  if (t.destroyed && t.destroyed.length > 0) {
    parts.push(` (destroyed: ${t.destroyed.join(', ')})`)
  }

  if (t.failed && t.failed.length > 0) {
    const failedKinds = t.failed.map(f => f.kind).join(', ')
    parts.push(`FAILED: ${failedKinds}`)
  }

  if (parts.length === 0) {
    return ''
  }

  if (parts.length === 1) {
    return parts[0]
  }

  // Both destroyed and failed exist
  return `${parts[0]}; ${parts[1]}`
}

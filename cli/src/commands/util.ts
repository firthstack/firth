export function formatTeardown(t: { destroyed?: string[]; failed?: { kind: string }[] }): string {
  let result = ''

  if (t.destroyed && t.destroyed.length > 0) {
    result += ` (destroyed: ${t.destroyed.join(', ')})`
  }

  if (t.failed && t.failed.length > 0) {
    const failedKinds = t.failed.map(f => f.kind).join(', ')
    result += result ? `; FAILED: ${failedKinds}` : ` FAILED: ${failedKinds}`
  }

  return result
}

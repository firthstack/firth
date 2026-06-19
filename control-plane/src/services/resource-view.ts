const WHITELIST: Record<string, string[]> = {
  neon: ['neonProjectId', 'defaultBranchId', 'dbName', 'roleName', 'host', 'database', 'region'],
  s3: ['bucket', 'bucketName', 'endpoint', 'region'],
  fly: ['app', 'appName', 'machineId', 'region'],
}

export function publicResourceView(r: { kind: string; status: string; provider_ref: Record<string, unknown> }) {
  const allowed = WHITELIST[r.kind] ?? []
  const ref: Record<string, unknown> = {}
  for (const k of allowed) if (k in r.provider_ref) ref[k] = r.provider_ref[k]
  return { kind: r.kind, status: r.status, provider_ref: ref }
}

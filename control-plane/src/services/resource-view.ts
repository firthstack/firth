const WHITELIST: Record<string, string[]> = {
  neon: ['neonProjectId', 'defaultBranchId', 'dbName', 'roleName', 'host', 'database', 'region'],
  s3: ['bucket', 'bucketName', 'endpoint', 'region'],
  fly: ['flyApp', 'orgSlug', 'app', 'appName', 'machineId', 'region'],
}

export function publicResourceView(r: { kind: string; status: string; branch_id?: string | null; provider_ref: Record<string, unknown> }) {
  const allowed = WHITELIST[r.kind] ?? []
  const ref: Record<string, unknown> = {}
  for (const k of allowed) if (k in r.provider_ref) ref[k] = r.provider_ref[k]
  return { kind: r.kind, status: r.status, branch_id: r.branch_id ?? null, provider_ref: ref }
}

import { useCallback, useEffect, useState } from 'react'
import { Panel, Row, TButton, TInput, Confirm, CliHint } from '../ui/Terminal'
import type { Api } from '../api/client'
import type { ProjectDetail as Detail, Resource, Branch } from '../types'

// ---------------------------------------------------------------------------
// Helper: copy text to clipboard (guarded for missing API)
// ---------------------------------------------------------------------------
function copyText(value: string) {
  navigator.clipboard?.writeText(value)
}

// ---------------------------------------------------------------------------
// Helper: copy a set of KEY=value pairs to clipboard
// ---------------------------------------------------------------------------
function copyDotEnv(pairs: Array<[string, string]>) {
  const text = pairs.map(([k, v]) => `${k}=${v}`).join('\n')
  navigator.clipboard?.writeText(text)
}

// ---------------------------------------------------------------------------
// Helper: live URL for a branch's Fly compute (null if not provisioned yet)
// ---------------------------------------------------------------------------
function flyUrlForBranch(branch: Branch, resources: Resource[]): string | null {
  // Prefer the compute resource explicitly tied to this branch...
  let r = resources.find((x) => x.kind === 'fly' && x.branch_id === branch.id)
  // ...but the default branch's compute may be recorded project-level (no branch_id).
  if (!r && branch.is_default) r = resources.find((x) => x.kind === 'fly' && !x.branch_id)
  const app = r ? String((r.provider_ref ?? {}).flyApp ?? '') : ''
  return app ? `https://${app}.fly.dev` : null
}

// ---------------------------------------------------------------------------
// Helper: relative "age" string from an ISO timestamp
// ---------------------------------------------------------------------------
function ago(iso?: string): string {
  if (!iso) return ''
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const secs = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (secs < 60) return `${secs}s ago`
  const mins = Math.round(secs / 60)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

// ---------------------------------------------------------------------------
// Helper: order branches by fork lineage (parent -> child), default first.
// Returns each branch with its tree depth so forks render indented.
// ---------------------------------------------------------------------------
function orderByLineage(branches: Branch[]): Array<{ branch: Branch; depth: number }> {
  const ids = new Set(branches.map((b) => b.id))
  const childrenOf = new Map<string, Branch[]>()
  for (const b of branches) {
    const p = b.parent_branch_id
    if (p && ids.has(p)) {
      const list = childrenOf.get(p) ?? []
      list.push(b)
      childrenOf.set(p, list)
    }
  }
  // roots = no parent, or a parent that isn't in this project's set
  const roots = branches
    .filter((b) => !b.parent_branch_id || !ids.has(b.parent_branch_id))
    .sort((a, b) => Number(b.is_default) - Number(a.is_default))

  const out: Array<{ branch: Branch; depth: number }> = []
  const seen = new Set<string>()
  const walk = (b: Branch, depth: number) => {
    if (seen.has(b.id)) return
    seen.add(b.id)
    out.push({ branch: b, depth })
    for (const c of childrenOf.get(b.id) ?? []) walk(c, depth + 1)
  }
  roots.forEach((r) => walk(r, 0))
  // any branches not reached (cycles / odd data) still get listed
  branches.forEach((b) => { if (!seen.has(b.id)) out.push({ branch: b, depth: 0 }) })
  return out
}

// ---------------------------------------------------------------------------
// StatusBadge — color-coded health glyph so half-created / failed branches
// (the ones that silently pile up) are visible at a glance.
// ---------------------------------------------------------------------------
const STATUS_STYLE: Record<string, { color: string; glyph: string }> = {
  active: { color: 'var(--green)', glyph: '●' },
  creating: { color: 'var(--amber)', glyph: '◐' },
  error: { color: 'var(--red)', glyph: '✕' },
  deleted: { color: 'var(--fg-dim)', glyph: '○' },
}
function StatusBadge({ status }: { status: string }) {
  const s = STATUS_STYLE[status] ?? { color: 'var(--fg-dim)', glyph: '○' }
  return (
    <span style={{ color: s.color, flexShrink: 0, minWidth: '11ch' }} title={`status: ${status}`}>
      {s.glyph} {status}
    </span>
  )
}

// ---------------------------------------------------------------------------
// SecretRow — labeled monospace line with optional [copy] button
// ---------------------------------------------------------------------------
function SecretRow({
  label,
  value,
  copyable = false,
}: {
  label: string
  value: string
  copyable?: boolean
}) {
  return (
    <Row>
      <span className="firth-dim" style={{ minWidth: '14ch', flexShrink: 0 }}>
        {label}
      </span>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <code style={{ whiteSpace: 'pre', fontFamily: 'inherit' }}>{value}</code>
        </div>
      </div>
      {copyable && (
        <TButton onClick={() => copyText(value)} style={{ flexShrink: 0 }}>
          [copy]
        </TButton>
      )}
    </Row>
  )
}

// ---------------------------------------------------------------------------
// BranchesPanel — the centerpiece: every branch as a lineage tree node with a
// status badge and its live URL inline. This is where the workflow lives, so
// it renders first and makes branch health + endpoints visible at a glance.
// ---------------------------------------------------------------------------
function BranchesPanel({
  branches,
  resources,
  creating,
  setCreating,
  name,
  setName,
  from,
  setFrom,
  busy,
  deletingBranch,
  onCreate,
  onRequestDelete,
}: {
  branches: Branch[]
  resources: Resource[]
  creating: boolean
  setCreating: (fn: (c: boolean) => boolean) => void
  name: string
  setName: (v: string) => void
  from: string
  setFrom: (v: string) => void
  busy: boolean
  deletingBranch: string | null
  onCreate: () => void
  onRequestDelete: (id: string) => void
}) {
  const total = branches.length
  const active = branches.filter((b) => b.status === 'active').length
  const unhealthy = branches.filter((b) => b.status !== 'active' && b.status !== 'deleted').length
  const ordered = orderByLineage(branches)

  return (
    <Panel title="branches">
      <Row>
        <TButton onClick={() => setCreating((c) => !c)}>[+ create branch]</TButton>
        <span style={{ flex: 1 }} />
        <span className="firth-dim">{total} total</span>
        <span style={{ color: 'var(--green)' }}>{active} active</span>
        {unhealthy > 0 && <span style={{ color: 'var(--amber)' }}>{unhealthy} pending/failed</span>}
      </Row>
      <CliHint command="firth branch create <name>" note="# forks an isolated db branch + its own compute & url" />
      <p className="firth-dim">each branch = isolated Neon branch + its own Fly machine (shared-cpu-1x · 256 MB) at its own url</p>
      {creating && (
        <Row>
          <label htmlFor="branch-name">name</label>
          <TInput id="branch-name" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
          <label htmlFor="branch-from">from</label>
          <TInput id="branch-from" value={from} onChange={(e) => setFrom(e.target.value)} disabled={busy} />
          <TButton onClick={onCreate} disabled={busy}>{busy ? 'creating…' : '[ok]'}</TButton>
          <TButton onClick={() => { setCreating(() => false); setName(''); setFrom('main') }} disabled={busy}>[cancel]</TButton>
        </Row>
      )}
      {ordered.map(({ branch: b, depth }) => {
        const url = flyUrlForBranch(b, resources)
        return (
          <Row key={b.id}>
            {depth > 0 && (
              <span className="firth-dim" style={{ flexShrink: 0, paddingLeft: `${(depth - 1) * 2}ch` }}>└─</span>
            )}
            <StatusBadge status={b.status} />
            <strong style={{ flexShrink: 0 }}>{b.name}</strong>
            {b.is_default && <span className="firth-dim" style={{ flexShrink: 0 }}>default</span>}
            <span style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
              <span style={{ overflowX: 'auto', display: 'block' }}>
                {url ? (
                  <a href={url} target="_blank" rel="noreferrer" style={{ color: 'var(--green)', whiteSpace: 'pre', fontFamily: 'inherit' }}>{url}</a>
                ) : (
                  <span className="firth-dim">no compute yet — `firth deploy`</span>
                )}
              </span>
            </span>
            {b.created_at && <span className="firth-dim" style={{ flexShrink: 0 }}>{ago(b.created_at)}</span>}
            {url && <TButton onClick={() => copyText(url)} style={{ flexShrink: 0 }}>[copy]</TButton>}
            {!b.is_default && (
              <TButton className="firth-btn--danger" onClick={() => onRequestDelete(b.id)} disabled={busy} style={{ flexShrink: 0 }}>
                {deletingBranch === b.id ? 'deleting…' : '[delete]'}
              </TButton>
            )}
          </Row>
        )
      })}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Postgres card
// ---------------------------------------------------------------------------
function PostgresCard({
  resource,
  databaseUrl,
}: {
  resource: Resource | undefined
  databaseUrl: string | undefined
}) {
  const ref = resource?.provider_ref ?? {}
  const neonProjectId = String(ref.neonProjectId ?? '')
  const dbName = String(ref.dbName ?? '')
  const roleName = String(ref.roleName ?? '')
  const neonBranchRef = String(ref.neonBranchRef ?? '')

  const envPairs: Array<[string, string]> = databaseUrl ? [['DATABASE_URL', databaseUrl]] : []

  return (
    <Panel title="postgres">
      {!resource ? (
        <p className="firth-dim">not provisioned</p>
      ) : (
        <>
          <Row>
            <TButton onClick={() => copyDotEnv(envPairs)}>[copy .env]</TButton>
            <span className="firth-dim">{resource.status}</span>
          </Row>
          {databaseUrl ? (
            <SecretRow label="DATABASE_URL" value={databaseUrl} copyable />
          ) : (
            <p className="firth-dim">DATABASE_URL not available</p>
          )}
          {dbName && <SecretRow label="dbName" value={dbName} />}
          {roleName && <SecretRow label="roleName" value={roleName} />}
          {neonProjectId && <SecretRow label="neonProjectId" value={neonProjectId} />}
          {neonBranchRef && <SecretRow label="neon_branch_ref" value={neonBranchRef} />}
        </>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Storage card
// ---------------------------------------------------------------------------
function StorageCard({
  resource,
  projectSecrets,
}: {
  resource: Resource | undefined
  projectSecrets: Record<string, string>
}) {
  const ref = resource?.provider_ref ?? {}
  const bucket =
    projectSecrets['BUCKET_NAME'] ?? String(ref.bucket ?? ref.bucketName ?? '')
  const endpoint =
    projectSecrets['AWS_ENDPOINT_URL_S3'] ?? String(ref.endpoint ?? '')
  const region = projectSecrets['AWS_REGION'] ?? String(ref.region ?? '')
  const accessKeyId = projectSecrets['AWS_ACCESS_KEY_ID'] ?? ''
  const secretKey = projectSecrets['AWS_SECRET_ACCESS_KEY'] ?? ''

  const envPairs: Array<[string, string]> = [
    ...(bucket ? ([['BUCKET_NAME', bucket]] as Array<[string, string]>) : []),
    ...(endpoint ? ([['AWS_ENDPOINT_URL_S3', endpoint]] as Array<[string, string]>) : []),
    ...(region ? ([['AWS_REGION', region]] as Array<[string, string]>) : []),
    ...(accessKeyId ? ([['AWS_ACCESS_KEY_ID', accessKeyId]] as Array<[string, string]>) : []),
    ...(secretKey ? ([['AWS_SECRET_ACCESS_KEY', secretKey]] as Array<[string, string]>) : []),
  ]

  return (
    <Panel title="storage">
      {!resource ? (
        <p className="firth-dim">not provisioned</p>
      ) : (
        <>
          <Row>
            <TButton onClick={() => copyDotEnv(envPairs)}>[copy .env]</TButton>
            <span className="firth-dim">{resource.status}</span>
          </Row>
          {bucket && <SecretRow label="BUCKET_NAME" value={bucket} />}
          {endpoint && <SecretRow label="AWS_ENDPOINT_URL_S3" value={endpoint} />}
          {region && <SecretRow label="AWS_REGION" value={region} />}
          {accessKeyId && <SecretRow label="AWS_ACCESS_KEY_ID" value={accessKeyId} copyable />}
          {secretKey && <SecretRow label="AWS_SECRET_ACCESS_KEY" value={secretKey} copyable />}
        </>
      )}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Approvals panel
// ---------------------------------------------------------------------------
function ApprovalsPanel({ api, projectId }: { api: Api; projectId: string }) {
  const [items, setItems] = useState<Array<{ id: string; action: string; requested_at: string }>>([])
  const load = useCallback(() => { api.listApprovals(projectId, 'pending').then(setItems).catch(() => setItems([])) }, [api, projectId])
  useEffect(() => { load() }, [load])
  const decide = useCallback(async (id: string, kind: 'approve' | 'deny') => { await (kind === 'approve' ? api.approve(projectId, id) : api.deny(projectId, id)); load() }, [api, projectId, load])
  return (
    <Panel title="approvals">
      {items.length === 0 ? (
        <p className="firth-dim">no pending approvals</p>
      ) : items.map((a) => (
        <Row key={a.id}>
          <strong>{a.action}</strong>
          <span className="firth-dim">{a.requested_at}</span>
          <TButton onClick={() => decide(a.id, 'approve')}>[approve]</TButton>
          <TButton onClick={() => decide(a.id, 'deny')}>[deny]</TButton>
        </Row>
      ))}
    </Panel>
  )
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------
export function ProjectDetail({ api, projectId, onBack }: { api: Api; projectId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [projectSecrets, setProjectSecrets] = useState<Record<string, string>>({})
  const [branchSecrets, setBranchSecrets] = useState<Record<string, string>>({})
  const [secretsGated, setSecretsGated] = useState(false)
  const [secretsApprovalId, setSecretsApprovalId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [deletingBranch, setDeletingBranch] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [from, setFrom] = useState('main')
  const [confirmBranch, setConfirmBranch] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true); setError(null); setSecretsGated(false); setSecretsApprovalId(null)
    try {
      const d = await api.getProject(projectId)
      setDetail(d)

      // Fetch secrets; allow partial failure so resources still render
      try {
        const ps = await api.getSecrets(projectId)
        setProjectSecrets(ps.secrets ?? {})
        if (ps.status === 'approval_required') { setSecretsGated(true); setSecretsApprovalId(ps.approvalId ?? null) }
      } catch {
        setError('failed to load project secrets')
      }

      const def = d.branches.find((b) => b.is_default) ?? d.branches[0]
      if (def) {
        try {
          const bs = await api.getSecrets(projectId, def.id)
          setBranchSecrets(bs.secrets ?? {})
        } catch {
          // branch secrets failure is non-fatal; DATABASE_URL just won't show
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'failed to load project')
    } finally {
      setLoading(false)
    }
  }, [api, projectId])

  useEffect(() => { void refresh() }, [refresh])

  async function create() {
    if (busy || !name.trim()) return
    setBusy(true); setError(null)
    try { await api.createBranch(projectId, name.trim(), from.trim() || 'main'); setName(''); setFrom('main'); setCreating(false); await refresh() }
    catch (err) { setError(err instanceof Error ? err.message : 'failed to create branch') }
    finally { setBusy(false) }
  }

  async function removeBranch(branchId: string) {
    if (busy) return
    setConfirmBranch(null); setBusy(true); setDeletingBranch(branchId); setError(null)
    try { await api.deleteBranch(projectId, branchId); await refresh() }
    catch (err) { setError(err instanceof Error ? err.message : 'failed to delete branch') }
    finally { setBusy(false); setDeletingBranch(null) }
  }

  const neonResource = detail?.resources.find((r) => r.kind === 'neon')
  const s3Resource = detail?.resources.find((r) => r.kind === 's3')

  return (
    <div>
      <Row>
        <TButton onClick={onBack}>[&lt; back]</TButton>
        <span>{detail?.project.name ?? projectId}</span>
        <span className="firth-dim">{detail?.project.status ?? ''}</span>
      </Row>
      <CliHint command={`firth project link ${projectId}`} note="# link this directory to the project" />
      {loading && <p className="firth-dim">loading...</p>}
      {error && <p className="firth-error">! {error}</p>}
      {detail && (
        <>
          {secretsGated && (
            <p className="firth-dim">
              {secretsApprovalId
                ? <><span aria-hidden="true">🔒</span>{` secrets require approval — run \`firth approve ${secretsApprovalId}\` or approve in the Approvals panel below, then reload.`}</>
                : <><span aria-hidden="true">🔒</span>{' secrets require approval — approve the pending request in the Approvals panel below (or run `firth approve <id>`), then reload.'}</>}
            </p>
          )}
          <BranchesPanel
            branches={detail.branches}
            resources={detail.resources}
            creating={creating}
            setCreating={setCreating}
            name={name}
            setName={setName}
            from={from}
            setFrom={setFrom}
            busy={busy}
            deletingBranch={deletingBranch}
            onCreate={create}
            onRequestDelete={setConfirmBranch}
          />
          <PostgresCard resource={neonResource} databaseUrl={branchSecrets['DATABASE_URL']} />
          <StorageCard resource={s3Resource} projectSecrets={projectSecrets} />
          <ApprovalsPanel api={api} projectId={projectId} />
          {confirmBranch && (
            <Confirm
              message="deleting this branch destroys its Neon branch. this is irreversible. continue?"
              onConfirm={() => removeBranch(confirmBranch)}
              onCancel={() => setConfirmBranch(null)}
            />
          )}
        </>
      )}
    </div>
  )
}

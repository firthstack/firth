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
// BranchGraph — a real visual fork graph: each branch is a node (colored by
// status), connected to its parent by an edge. Top-down layered layout; nodes
// link to their live URL. This is the "chart of the branching" view.
// ---------------------------------------------------------------------------
function BranchGraph({ branches, resources, envState }: { branches: Branch[]; resources: Resource[]; envState?: Record<string, string> }) {
  const ids = new Set(branches.map((b) => b.id))
  const childrenOf = new Map<string, Branch[]>()
  for (const b of branches) {
    const p = b.parent_branch_id && ids.has(b.parent_branch_id) ? b.parent_branch_id : null
    if (p) {
      const list = childrenOf.get(p) ?? []
      list.push(b)
      childrenOf.set(p, list)
    }
  }
  const roots = branches
    .filter((b) => !b.parent_branch_id || !ids.has(b.parent_branch_id))
    .sort((a, b) => Number(b.is_default) - Number(a.is_default))

  // DFS to assign a tree depth to each node (children sit one row below parent).
  const depthOf = new Map<string, number>()
  const seen = new Set<string>()
  const walk = (b: Branch, depth: number) => {
    if (seen.has(b.id)) return
    seen.add(b.id)
    depthOf.set(b.id, depth)
    for (const c of childrenOf.get(b.id) ?? []) walk(c, depth + 1)
  }
  roots.forEach((r) => walk(r, 0))
  branches.forEach((b) => { if (!seen.has(b.id)) depthOf.set(b.id, 0) })

  // Group by depth → each depth is a horizontal row; spread nodes evenly.
  const rows = new Map<number, Branch[]>()
  branches.forEach((b) => {
    const d = depthOf.get(b.id) ?? 0
    const list = rows.get(d) ?? []
    list.push(b)
    rows.set(d, list)
  })

  const NODE_W = 190
  const NODE_H = 58
  const GAP_X = 28
  const GAP_Y = 64
  const PAD = 12
  const maxRow = Math.max(1, ...[...rows.values()].map((r) => r.length))
  const maxDepth = Math.max(0, ...[...depthOf.values()])
  const width = PAD * 2 + maxRow * NODE_W + (maxRow - 1) * GAP_X
  const height = PAD * 2 + (maxDepth + 1) * NODE_H + maxDepth * GAP_Y

  const pos = new Map<string, { x: number; y: number }>()
  ;[...rows.entries()].forEach(([depth, row]) => {
    const rowW = row.length * NODE_W + (row.length - 1) * GAP_X
    const offset = (width - rowW) / 2
    row.forEach((b, i) => {
      pos.set(b.id, {
        x: offset + i * (NODE_W + GAP_X) + NODE_W / 2,
        y: PAD + depth * (NODE_H + GAP_Y) + NODE_H / 2,
      })
    })
  })

  const colorFor = (status: string) =>
    (STATUS_STYLE[status]?.color ?? 'var(--fg-dim)')
  const glyphFor = (status: string) => (STATUS_STYLE[status]?.glyph ?? '○')

  return (
    <Panel title="environments">
      <div style={{ width: '100%', overflowX: 'auto' }}>
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width={width}
          height={height}
          role="img"
          aria-label="branch fork graph"
          style={{ maxWidth: '100%', height: 'auto', display: 'block' }}
        >
          {/* edges: parent bottom-center → child top-center */}
          {branches.map((b) => {
            const p = b.parent_branch_id && ids.has(b.parent_branch_id) ? b.parent_branch_id : null
            if (!p) return null
            const cp = pos.get(p)
            const cc = pos.get(b.id)
            if (!cp || !cc) return null
            const x1 = cp.x, y1 = cp.y + NODE_H / 2
            const x2 = cc.x, y2 = cc.y - NODE_H / 2
            const midY = (y1 + y2) / 2
            return (
              <path
                key={`e-${b.id}`}
                d={`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`}
                fill="none"
                stroke="var(--border)"
                strokeWidth={1.5}
              />
            )
          })}
          {/* nodes */}
          {branches.map((b) => {
            const c = pos.get(b.id)
            if (!c) return null
            const x = c.x - NODE_W / 2
            const y = c.y - NODE_H / 2
            const col = colorFor(b.status)
            const url = flyUrlForBranch(b, resources)
            const st = envState?.[b.id]
            const stLabel = st === 'running' ? '● live' : st === 'suspended' ? '💤 asleep · $0' : st === 'stopped' ? '○ stopped' : ''
            const stColor = st === 'running' ? 'var(--green)' : st === 'suspended' ? 'var(--amber)' : 'var(--fg-dim)'
            const node = (
              <g>
                <rect
                  x={x}
                  y={y}
                  width={NODE_W}
                  height={NODE_H}
                  rx={4}
                  fill="var(--bg-panel)"
                  stroke={col}
                  strokeWidth={b.is_default ? 2 : 1.25}
                />
                <text x={x + 10} y={y + 19} fill={col} fontSize={13} fontFamily="var(--mono)">
                  {glyphFor(b.status)} {b.name}{b.is_default ? '  (default)' : ''}
                </text>
                <text x={x + 10} y={y + 36} fontSize={11} fontFamily="var(--mono)">
                  {stLabel ? <tspan fill={stColor}>{stLabel}  </tspan> : null}
                  <tspan fill="var(--fg-dim)">{url ? url.replace(/^https:\/\//, '') : 'no compute'}</tspan>
                </text>
                <text x={x + 10} y={y + 51} fontSize={9.5} fontFamily="var(--mono)">
                  <tspan fill="var(--green)">db</tspan><tspan fill="var(--fg-dim)"> branch · store </tspan><tspan fill="var(--fg-dim)">shared{url ? ' · compute' : ''}</tspan>
                </text>
              </g>
            )
            return url ? (
              <a key={`n-${b.id}`} href={url} target="_blank" rel="noreferrer">{node}</a>
            ) : (
              <g key={`n-${b.id}`}>{node}</g>
            )
          })}
        </svg>
      </div>
      <p className="firth-dim">
        serverless: <span style={{ color: 'var(--green)' }}>● live</span>{'   '}
        <span style={{ color: 'var(--amber)' }}>💤 asleep · $0</span>{'   '}
        <span>○ stopped</span>{'  ·  idle environments scale to zero · click a node to open'}
      </p>
      <p className="firth-dim">each environment is a full clone — its <b style={{ color: 'var(--fg)' }}>own Neon database branch</b> + <b style={{ color: 'var(--fg)' }}>own compute/URL</b>; the Tigris <b style={{ color: 'var(--fg)' }}>storage bucket is shared</b> across environments.</p>
    </Panel>
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
const IMAGE_PRESETS = [
  { label: 'Nginx — static web (nginx)', image: 'nginx:latest', port: '80' },
  { label: 'Whoami — echo server (traefik/whoami)', image: 'traefik/whoami:latest', port: '80' },
  { label: 'Hello — Fly demo (flyio/hellofly)', image: 'flyio/hellofly:latest', port: '8080' },
  { label: 'Custom image…', image: '', port: '8080' },
]
const SELECT_STYLE: React.CSSProperties = {
  fontFamily: 'inherit', fontSize: 14, color: 'var(--fg)', background: 'var(--bg-soft)',
  border: '1px solid var(--border)', borderRadius: 6, padding: '6px 8px',
}
function DeployPanel({ api, projectId, branches }: { api: Api; projectId: string; branches: Branch[] }) {
  const [preset, setPreset] = useState(0)
  const [custom, setCustom] = useState('')
  const [port, setPort] = useState('80')
  const [target, setTarget] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const isCustom = preset === IMAGE_PRESETS.length - 1
  const image = isCustom ? custom.trim() : IMAGE_PRESETS[preset].image
  function pick(i: number) { setPreset(i); setPort(IMAGE_PRESETS[i].port) }
  async function go() {
    if (!image || busy) return
    setBusy(true); setError(null); setResult(null)
    try {
      const out = await api.deployImage(projectId, image, Number(port) || 80, target || undefined)
      setResult((out as { url?: string })?.url ?? 'deployed')
    } catch (e) { setError(e instanceof Error ? e.message : 'deploy failed') }
    finally { setBusy(false) }
  }
  return (
    <Panel title="deploy">
      <CliHint command="firth deploy --image <url> --port <n>" note="# same deploy a human clicks or an agent runs via the firth skill" />
      <Row>
        <label htmlFor="dep-env">to env</label>
        <select id="dep-env" value={target} onChange={(e) => setTarget(e.target.value)} disabled={busy} style={SELECT_STYLE}>
          {branches.map((b) => <option key={b.id} value={b.is_default ? '' : b.id}>{b.name}{b.is_default ? ' (default)' : ''}</option>)}
        </select>
        <label htmlFor="dep-img">image</label>
        <select id="dep-img" value={preset} onChange={(e) => pick(Number(e.target.value))} disabled={busy} style={SELECT_STYLE}>
          {IMAGE_PRESETS.map((pr, i) => <option key={i} value={i}>{pr.label}</option>)}
        </select>
        <label htmlFor="dep-port">port</label>
        <TInput id="dep-port" value={port} onChange={(e) => setPort(e.target.value)} disabled={busy} style={{ maxWidth: '8ch' }} />
        <TButton onClick={go} disabled={busy || !image}>{busy ? 'deploying…' : '[deploy]'}</TButton>
      </Row>
      {isCustom && (
        <Row>
          <label htmlFor="dep-custom">image url</label>
          <TInput id="dep-custom" value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="registry.fly.io/app:tag  or  docker.io/library/nginx" disabled={busy} />
        </Row>
      )}
      <p className="firth-dim">deploys a prebuilt image to the chosen environment (replaces its machine). build-from-source is the next step.</p>
      {result && <p className="firth-dim">deployed → <a href={result} target="_blank" rel="noreferrer" style={{ color: 'var(--green)' }}>{result}</a></p>}
      {error && <p className="firth-error">! {error}</p>}
    </Panel>
  )
}

export function ProjectDetail({ api, projectId, onBack }: { api: Api; projectId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [envState, setEnvState] = useState<Record<string, string>>({})
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
      // serverless runtime state per env (non-blocking; absent in tests)
      api.getStatus?.(projectId)?.then((s) => setEnvState(Object.fromEntries((s.environments ?? []).map((e) => [e.branchId, e.state])))).catch(() => {})

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
          <BranchGraph branches={detail.branches} resources={detail.resources} envState={envState} />
          <DeployPanel api={api} projectId={projectId} branches={detail.branches} />
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

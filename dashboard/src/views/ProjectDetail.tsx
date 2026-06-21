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
// LinkRow — labeled clickable URL (opens in a new tab) with a [copy] button
// ---------------------------------------------------------------------------
function LinkRow({ label, href }: { label: string; href: string }) {
  return (
    <Row>
      <span className="firth-dim" style={{ minWidth: '14ch', flexShrink: 0 }}>
        {label}
      </span>
      <div style={{ flex: 1, overflow: 'hidden' }}>
        <div style={{ overflowX: 'auto' }}>
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            style={{ whiteSpace: 'pre', fontFamily: 'inherit', color: 'inherit' }}
          >
            {href}
          </a>
        </div>
      </div>
      <TButton onClick={() => copyText(href)} style={{ flexShrink: 0 }}>
        [copy]
      </TButton>
    </Row>
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
// Compute card
// ---------------------------------------------------------------------------
function ComputeCard({ resources, branches }: { resources: Resource[]; branches: Branch[] }) {
  const flyResources = resources.filter((r) => r.kind === 'fly')
  const nameFor = (id?: string) => branches.find((b) => b.id === id)?.name ?? '(unknown branch)'
  return (
    <Panel title="compute">
      {flyResources.length === 0 ? (
        <p className="firth-dim">not provisioned</p>
      ) : (
        flyResources.map((resource) => {
          const ref = resource.provider_ref ?? {}
          const flyApp = String(ref.flyApp ?? '')
          const orgSlug = String(ref.orgSlug ?? '')
          return (
            <div key={resource.branch_id ?? flyApp}>
              <Row>
                <strong>{nameFor(resource.branch_id)}</strong>
                <span className="firth-dim">{resource.status}</span>
              </Row>
              {flyApp && <SecretRow label="app" value={flyApp} />}
              {flyApp && <LinkRow label="url" href={`https://${flyApp}.fly.dev`} />}
              {orgSlug && <SecretRow label="org" value={orgSlug} />}
              <SecretRow label="spec" value="shared-cpu-1x · 1 vCPU · 256 MB" />
            </div>
          )
        })
      )}
      {flyResources.length > 0 && (
        <p className="firth-dim">deploy with `firth deploy` to create a machine</p>
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
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [from, setFrom] = useState('main')
  const [confirmBranch, setConfirmBranch] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true); setError(null); setSecretsGated(false)
    try {
      const d = await api.getProject(projectId)
      setDetail(d)

      // Fetch secrets; allow partial failure so resources still render
      try {
        const ps = await api.getSecrets(projectId)
        setProjectSecrets(ps.secrets ?? {})
        if (ps.status === 'approval_required') setSecretsGated(true)
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
    if (!name.trim()) return
    setError(null)
    try { await api.createBranch(projectId, name.trim(), from.trim() || 'main'); setName(''); setFrom('main'); setCreating(false); await refresh() }
    catch (err) { setError(err instanceof Error ? err.message : 'failed to create branch') }
  }

  async function removeBranch(branchId: string) {
    setConfirmBranch(null); setError(null)
    try { await api.deleteBranch(projectId, branchId); await refresh() }
    catch (err) { setError(err instanceof Error ? err.message : 'failed to delete branch') }
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
            <p className="firth-dim">🔒 secrets require approval — approve the pending request in the Approvals panel below (or run `firth approve &lt;id&gt;`), then reload.</p>
          )}
          <PostgresCard resource={neonResource} databaseUrl={branchSecrets['DATABASE_URL']} />
          <StorageCard resource={s3Resource} projectSecrets={projectSecrets} />
          <ComputeCard resources={detail?.resources ?? []} branches={detail?.branches ?? []} />
          <ApprovalsPanel api={api} projectId={projectId} />
          <Panel title="branches">
            <Row><TButton onClick={() => setCreating((c) => !c)}>[+ create branch]</TButton></Row>
            <CliHint command="firth branch create <name>" note="# or from the cli — forks an isolated db branch" />
            {creating && (
              <Row>
                <label htmlFor="branch-name">name</label>
                <TInput id="branch-name" value={name} onChange={(e) => setName(e.target.value)} />
                <label htmlFor="branch-from">from</label>
                <TInput id="branch-from" value={from} onChange={(e) => setFrom(e.target.value)} />
                <TButton onClick={create}>[ok]</TButton>
                <TButton onClick={() => { setCreating(false); setName(''); setFrom('main') }}>[cancel]</TButton>
              </Row>
            )}
            {detail.branches.map((b) => (
              <Row key={b.id}>
                <span style={{ flex: 1 }}>{b.name}</span>
                {b.is_default && <span className="firth-dim">default</span>}
                <span className="firth-dim">{b.neon_branch_ref ?? '-'}</span>
                <span className="firth-dim">{b.status}</span>
                {!b.is_default && (
                  <TButton className="firth-btn--danger" onClick={() => setConfirmBranch(b.id)}>[delete]</TButton>
                )}
              </Row>
            ))}
          </Panel>
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

import { useCallback, useEffect, useState } from 'react'
import { Panel, Row, TButton, TInput, Confirm } from '../ui/Terminal'
import type { Api } from '../api/client'
import type { ProjectDetail as Detail } from '../types'

export function ProjectDetail({ api, projectId, onBack }: { api: Api; projectId: string; onBack: () => void }) {
  const [detail, setDetail] = useState<Detail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [from, setFrom] = useState('main')
  const [confirmBranch, setConfirmBranch] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try { setDetail(await api.getProject(projectId)) }
    catch (err) { setError(err instanceof Error ? err.message : 'failed to load project') }
    finally { setLoading(false) }
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

  return (
    <div>
      <Row>
        <TButton onClick={onBack}>[&lt; back]</TButton>
        <span>{detail?.project.name ?? projectId}</span>
        <span className="firth-dim">{detail?.project.status ?? ''}</span>
      </Row>
      {loading && <p className="firth-dim">loading...</p>}
      {error && <p className="firth-error">! {error}</p>}
      {detail && (
        <>
          <Panel title="resources">
            {detail.resources.length === 0 && <p className="firth-dim">no resources</p>}
            {detail.resources.map((r, i) => (
              <Row key={`${r.kind}-${i}`}>
                <span style={{ flex: 1 }}>{r.kind}</span>
                <span className="firth-dim">{r.status}</span>
                <span className="firth-dim">{Object.entries(r.provider_ref).map(([k, v]) => `${k}=${String(v)}`).join(' ')}</span>
              </Row>
            ))}
          </Panel>
          <Panel title="branches">
            <Row><TButton onClick={() => setCreating((c) => !c)}>[+ create branch]</TButton></Row>
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

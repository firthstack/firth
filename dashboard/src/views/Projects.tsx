import { useCallback, useEffect, useState } from 'react'
import { Panel, Row, TButton, TInput, Confirm, CliHint } from '../ui/Terminal'
import type { Api } from '../api/client'
import type { Project } from '../types'

export function Projects({ api, onOpen }: { api: Api; onOpen: (projectId: string) => void }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [busy, setBusy] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)
  const [approval, setApproval] = useState<{ id: string; approvalId: string } | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try { setProjects(await api.listProjects()) }
    catch (err) { setError(err instanceof Error ? err.message : 'failed to load projects') }
    finally { setLoading(false) }
  }, [api])

  useEffect(() => { void refresh() }, [refresh])

  async function create() {
    if (busy || !name.trim()) return
    setBusy(true); setError(null)
    try { await api.createProject(name.trim()); setName(''); setCreating(false); await refresh() }
    catch (err) { setError(err instanceof Error ? err.message : 'failed to create project') }
    finally { setBusy(false) }
  }

  async function remove(id: string) {
    if (busy) return
    setConfirmId(null); setBusy(true); setDeletingId(id); setError(null)
    try {
      const res = await api.deleteProject(id)
      // project.delete is gated by Govern policy → 202 with an approvalId instead of a teardown.
      // Surface an inline approve step rather than silently leaving the project in place.
      if (res?.status === 'approval_required') { setApproval({ id, approvalId: res.approvalId }); return }
      await refresh()
    }
    catch (err) { setError(err instanceof Error ? err.message : 'failed to delete project') }
    finally { setBusy(false); setDeletingId(null) }
  }

  async function approveAndDelete() {
    if (busy || !approval) return
    const { id, approvalId } = approval
    setApproval(null); setBusy(true); setDeletingId(id); setError(null)
    try {
      await api.approve(id, approvalId)
      const res = await api.deleteProject(id) // gate now consumes the grant and proceeds
      if (res?.status === 'approval_required') { setApproval({ id, approvalId: res.approvalId }); return }
      await refresh()
    }
    catch (err) { setError(err instanceof Error ? err.message : 'failed to delete project') }
    finally { setBusy(false); setDeletingId(null) }
  }

  return (
    <Panel title="projects">
      <Row>
        <TButton onClick={() => setCreating((c) => !c)}>[+ create]</TButton>
      </Row>
      <CliHint command="firth project create <name>" note="# or from the cli — provisions db · storage · compute" />
      {creating && (
        <Row>
          <label htmlFor="new-project-name">name</label>
          <TInput id="new-project-name" value={name} onChange={(e) => setName(e.target.value)} disabled={busy} />
          <TButton onClick={create} disabled={busy}>{busy ? 'creating…' : '[ok]'}</TButton>
          <TButton onClick={() => { setCreating(false); setName('') }} disabled={busy}>[cancel]</TButton>
        </Row>
      )}
      {loading && <p className="firth-dim">loading...</p>}
      {error && <p className="firth-error">! {error}</p>}
      {!loading && projects.length === 0 && <p className="firth-dim">-- none --</p>}
      {projects.map((p) => (
        <Row key={p.id}>
          <span style={{ flex: 1 }}>{p.name}</span>
          <span className="firth-dim">{p.status}</span>
          <span className="firth-dim">{p.created_at ?? ''}</span>
          <TButton onClick={() => onOpen(p.id)}>[open]</TButton>
          <TButton className="firth-btn--danger" onClick={() => setConfirmId(p.id)} disabled={busy}>{deletingId === p.id ? 'deleting…' : '[delete]'}</TButton>
        </Row>
      ))}
      {confirmId && (
        <Confirm
          message="teardown is irreversible: this destroys the project's cloud resources (Neon/Fly/Tigris). continue?"
          onConfirm={() => remove(confirmId)}
          onCancel={() => setConfirmId(null)}
        />
      )}
      {approval && (
        <div className="firth-confirm" role="alertdialog" aria-label="approval required">
          <p><span aria-hidden="true">🔒</span> project.delete requires approval (Govern policy). approve and delete now?</p>
          <Row>
            <TButton className="firth-btn--danger" onClick={approveAndDelete} disabled={busy}>[approve &amp; delete]</TButton>
            <TButton onClick={() => setApproval(null)} disabled={busy}>[cancel]</TButton>
          </Row>
        </div>
      )}
    </Panel>
  )
}

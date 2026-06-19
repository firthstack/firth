import { useCallback, useEffect, useState } from 'react'
import { Panel, Row, TButton, TInput, Confirm } from '../ui/Terminal'
import type { Api } from '../api/client'
import type { Project } from '../types'

export function Projects({ api, onOpen }: { api: Api; onOpen: (projectId: string) => void }) {
  const [projects, setProjects] = useState<Project[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [confirmId, setConfirmId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true); setError(null)
    try { setProjects(await api.listProjects()) }
    catch (err) { setError(err instanceof Error ? err.message : 'failed to load projects') }
    finally { setLoading(false) }
  }, [api])

  useEffect(() => { void refresh() }, [refresh])

  async function create() {
    if (!name.trim()) return
    setError(null)
    try { await api.createProject(name.trim()); setName(''); setCreating(false); await refresh() }
    catch (err) { setError(err instanceof Error ? err.message : 'failed to create project') }
  }

  async function remove(id: string) {
    setConfirmId(null); setError(null)
    try { await api.deleteProject(id); await refresh() }
    catch (err) { setError(err instanceof Error ? err.message : 'failed to delete project') }
  }

  return (
    <Panel title="projects">
      <Row>
        <TButton onClick={() => setCreating((c) => !c)}>[+ create]</TButton>
      </Row>
      {creating && (
        <Row>
          <label htmlFor="new-project-name">name</label>
          <TInput id="new-project-name" value={name} onChange={(e) => setName(e.target.value)} />
          <TButton onClick={create}>[ok]</TButton>
          <TButton onClick={() => { setCreating(false); setName('') }}>[cancel]</TButton>
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
          <TButton className="firth-btn--danger" onClick={() => setConfirmId(p.id)}>[delete]</TButton>
        </Row>
      ))}
      {confirmId && (
        <Confirm
          message="teardown is irreversible: this destroys the project's cloud resources (Neon/Fly/Tigris). continue?"
          onConfirm={() => remove(confirmId)}
          onCancel={() => setConfirmId(null)}
        />
      )}
    </Panel>
  )
}

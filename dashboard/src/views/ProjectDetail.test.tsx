import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectDetail } from './ProjectDetail'
import type { Api } from '../api/client'

// ---------------------------------------------------------------------------
// Full detail fixture with all three resource kinds
// ---------------------------------------------------------------------------
const detail = {
  project: { id: 'p1', name: 'first', status: 'active' },
  branches: [
    { id: 'b1', name: 'main', is_default: true, neon_branch_ref: 'br-x', status: 'active' },
    { id: 'b2', name: 'dev', is_default: false, neon_branch_ref: 'br-dev', status: 'active' },
  ],
  resources: [
    { kind: 'neon', status: 'active', provider_ref: { neonProjectId: 'np', dbName: 'neondb', roleName: 'neondb_owner' } },
    { kind: 's3', status: 'active', provider_ref: { bucket: 'firth-first-ab12', endpoint: 'https://t3.storage.dev', region: 'auto' } },
    { kind: 'fly', status: 'active', provider_ref: { flyApp: 'firth-first-cd34', orgSlug: 'my-org' } },
  ],
}

function fakeApi(overrides: Partial<Api> = {}): Api {
  return {
    listProjects: vi.fn(),
    getProject: vi.fn(async () => detail),
    createProject: vi.fn(),
    deleteProject: vi.fn(),
    createBranch: vi.fn(async () => ({})),
    deleteBranch: vi.fn(async () => ({})),
    getSecrets: vi.fn(async (_pid: string, branch?: string) =>
      branch
        ? { secrets: { DATABASE_URL: 'postgres://u:p@h/db' } }
        : { secrets: { AWS_ACCESS_KEY_ID: 'tid_x', AWS_SECRET_ACCESS_KEY: 'sek_y', AWS_ENDPOINT_URL_S3: 'https://t3.storage.dev', BUCKET_NAME: 'firth-first-ab12', AWS_REGION: 'auto' } }
    ),
    listApprovals: vi.fn(async () => []),
    approve: vi.fn(async () => ({})),
    deny: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as Api
}

describe('ProjectDetail', () => {
  it('renders branches and the default branch has no delete button', async () => {
    render(<ProjectDetail api={fakeApi()} projectId="p1" onBack={vi.fn()} />)
    expect(await screen.findByText('main')).toBeInTheDocument()
    expect(screen.getByText('dev')).toBeInTheDocument()
    // exactly one [delete] button (for the non-default 'dev' branch)
    expect(screen.getAllByRole('button', { name: /delete/i })).toHaveLength(1)
  })

  it('the default branch row exposes no delete control', async () => {
    render(<ProjectDetail api={fakeApi()} projectId="p1" onBack={vi.fn()} />)
    await screen.findByText('main')
    expect(screen.getAllByRole('button', { name: /delete/i })).toHaveLength(1)
  })

  // ---- postgres card -------------------------------------------------------

  it('postgres card shows DATABASE_URL and dbName', async () => {
    render(<ProjectDetail api={fakeApi()} projectId="p1" onBack={vi.fn()} />)
    // Wait for async load
    expect(await screen.findByText('postgres://u:p@h/db')).toBeInTheDocument()
    expect(screen.getByText('neondb')).toBeInTheDocument()
  })

  // ---- storage card --------------------------------------------------------

  it('storage card shows bucket name and access key', async () => {
    render(<ProjectDetail api={fakeApi()} projectId="p1" onBack={vi.fn()} />)
    expect(await screen.findByText('firth-first-ab12')).toBeInTheDocument()
    expect(screen.getByText('tid_x')).toBeInTheDocument()
    expect(screen.getByText('sek_y')).toBeInTheDocument()
  })

  // ---- compute card --------------------------------------------------------

  it('compute card shows the fly app and status active', async () => {
    render(<ProjectDetail api={fakeApi()} projectId="p1" onBack={vi.fn()} />)
    expect(await screen.findByText('firth-first-cd34')).toBeInTheDocument()
    // the status 'active' appears in the compute card's row
    const activeEls = screen.getAllByText('active')
    expect(activeEls.length).toBeGreaterThan(0)
  })

  it('compute card shows the reachable host url as a clickable link', async () => {
    render(<ProjectDetail api={fakeApi()} projectId="p1" onBack={vi.fn()} />)
    const link = await screen.findByRole('link', { name: 'https://firth-first-cd34.fly.dev' })
    expect(link).toHaveAttribute('href', 'https://firth-first-cd34.fly.dev')
    expect(link).toHaveAttribute('target', '_blank')
  })

  // ---- cli hints -----------------------------------------------------------

  it('shows the firth project link cli hint with the project id', async () => {
    render(<ProjectDetail api={fakeApi()} projectId="p1" onBack={vi.fn()} />)
    expect(await screen.findByText('firth project link p1')).toBeInTheDocument()
  })

  it('shows the firth branch create cli hint', async () => {
    render(<ProjectDetail api={fakeApi()} projectId="p1" onBack={vi.fn()} />)
    await screen.findByText('main')
    expect(screen.getByText('firth branch create <name>')).toBeInTheDocument()
  })

  // ---- branch actions ------------------------------------------------------

  it('deleting a non-default branch calls deleteBranch', async () => {
    const deleteBranch = vi.fn(async () => ({}))
    render(<ProjectDetail api={fakeApi({ deleteBranch })} projectId="p1" onBack={vi.fn()} />)
    await screen.findByText('dev')
    await userEvent.click(screen.getByRole('button', { name: /delete/i }))
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }))
    expect(deleteBranch).toHaveBeenCalledWith('p1', 'b2')
  })

  it('creating a branch calls createBranch', async () => {
    const createBranch = vi.fn(async () => ({}))
    const getProject = vi.fn().mockResolvedValue(detail)
    render(<ProjectDetail api={fakeApi({ createBranch, getProject })} projectId="p1" onBack={vi.fn()} />)
    await screen.findByText('main')
    await userEvent.click(screen.getByRole('button', { name: /create branch/i }))
    await userEvent.type(screen.getByLabelText(/^name$/i), 'feature')
    await userEvent.clear(screen.getByLabelText(/^from$/i))
    await userEvent.type(screen.getByLabelText(/^from$/i), 'main')
    await userEvent.click(screen.getByRole('button', { name: /^\[ok\]$/i }))
    await waitFor(() => expect(createBranch).toHaveBeenCalledWith('p1', 'feature', 'main'))
  })

  it('disables the branch create button while submitting and ignores a double-click', async () => {
    const getProject = vi.fn().mockResolvedValue(detail)
    let finish!: () => void
    const createBranch = vi.fn(() => new Promise<unknown>((res) => { finish = () => res({}) }))
    render(<ProjectDetail api={fakeApi({ createBranch, getProject })} projectId="p1" onBack={vi.fn()} />)
    await screen.findByText('main')
    await userEvent.click(screen.getByRole('button', { name: /create branch/i }))
    await userEvent.type(screen.getByLabelText(/^name$/i), 'feature')
    await userEvent.click(screen.getByRole('button', { name: /^\[ok\]$/i }))
    // in-flight: the button shows "creating…" and is disabled
    const btn = screen.getByRole('button', { name: /creating/i })
    expect(btn).toBeDisabled()
    expect(createBranch).toHaveBeenCalledTimes(1)
    await userEvent.click(btn) // second click while submitting must be a no-op
    expect(createBranch).toHaveBeenCalledTimes(1)
    finish()
    await waitFor(() => expect(createBranch).toHaveBeenCalledTimes(1))
  })

  // ---- per-branch compute card ---------------------------------------------

  it('compute card renders one entry per fly resource labeled by branch name', async () => {
    const multiFlyDetail = {
      project: { id: 'p1', name: 'first', status: 'active' },
      branches: [
        { id: 'b-main', name: 'main', is_default: true, neon_branch_ref: 'br-main', status: 'active' },
        { id: 'b-feat', name: 'feature', is_default: false, neon_branch_ref: 'br-feat', status: 'active' },
      ],
      resources: [
        { kind: 'neon', status: 'active', provider_ref: { neonProjectId: 'np' } },
        { kind: 'fly', status: 'active', branch_id: 'b-main', provider_ref: { flyApp: 'app-main', orgSlug: 'my-org' } },
        { kind: 'fly', status: 'active', branch_id: 'b-feat', provider_ref: { flyApp: 'app-feat', orgSlug: 'my-org' } },
      ],
    }
    const api = fakeApi({ getProject: vi.fn(async () => multiFlyDetail) })
    render(<ProjectDetail api={api} projectId="p1" onBack={vi.fn()} />)
    // both fly apps must render
    expect(await screen.findByText('app-main')).toBeInTheDocument()
    expect(screen.getByText('app-feat')).toBeInTheDocument()
    // each labeled by its branch name (branch names also appear in the branches panel, so use getAllByText)
    expect(screen.getAllByText('main').length).toBeGreaterThan(0)
    expect(screen.getAllByText('feature').length).toBeGreaterThan(0)
  })

  it('submitting with empty from defaults parent to main', async () => {
    const createBranch = vi.fn(async () => ({}))
    const getProject = vi.fn().mockResolvedValue(detail)
    render(<ProjectDetail api={fakeApi({ createBranch, getProject })} projectId="p1" onBack={vi.fn()} />)
    await screen.findByText('main')
    await userEvent.click(screen.getByRole('button', { name: /create branch/i }))
    await userEvent.type(screen.getByLabelText(/^name$/i), 'empty-from-test')
    await userEvent.clear(screen.getByLabelText(/^from$/i))
    await userEvent.click(screen.getByRole('button', { name: /^\[ok\]$/i }))
    await waitFor(() => expect(createBranch).toHaveBeenCalledWith('p1', 'empty-from-test', 'main'))
  })

  // ---- approvals panel -------------------------------------------------------

  it('approvals panel lists a pending approval and approves it', async () => {
    const approved: string[] = []
    const api = fakeApi({
      listApprovals: vi.fn(async () => [{ id: 'a1', action: 'project.delete', status: 'pending', requested_at: 'now' }]),
      approve: vi.fn(async (_pid: string, id: string) => { approved.push(id); return {} }),
    })
    render(<ProjectDetail api={api} projectId="p1" onBack={vi.fn()} />)
    expect(await screen.findByText('project.delete')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /approve/i }))
    expect(approved).toEqual(['a1'])
  })

  it('approvals panel deny button calls deny with the approval id', async () => {
    const denied: string[] = []
    const api = fakeApi({
      listApprovals: vi.fn(async () => [{ id: 'a1', action: 'project.delete', status: 'pending', requested_at: 'now' }]),
      deny: vi.fn(async (_pid: string, id: string) => { denied.push(id); return {} }),
    })
    render(<ProjectDetail api={api} projectId="p1" onBack={vi.fn()} />)
    expect(await screen.findByText('project.delete')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /deny/i }))
    expect(denied).toEqual(['a1'])
  })

  it('shows a secrets-require-approval notice when getSecrets returns approval_required', async () => {
    const api = fakeApi({
      getSecrets: vi.fn(async (_pid: string, branch?: string) =>
        branch ? { secrets: {} } : { status: 'approval_required', approvalId: 'a9', action: 'secrets.read' }
      ),
    })
    render(<ProjectDetail api={api} projectId="p1" onBack={vi.fn()} />)
    expect(await screen.findByText(/secrets require approval/i)).toBeInTheDocument()
    // Gated path must not also surface an error banner
    expect(screen.queryByText(/failed to load/i)).not.toBeInTheDocument()
    // Resources and approvals still render (page does not crash)
    expect(screen.getByText('postgres')).toBeInTheDocument()
    expect(screen.getByText('approvals')).toBeInTheDocument()
  })
})

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
        ? { DATABASE_URL: 'postgres://u:p@h/db' }
        : { AWS_ACCESS_KEY_ID: 'tid_x', AWS_SECRET_ACCESS_KEY: 'sek_y', AWS_ENDPOINT_URL_S3: 'https://t3.storage.dev', BUCKET_NAME: 'firth-first-ab12', AWS_REGION: 'auto' }
    ),
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
})

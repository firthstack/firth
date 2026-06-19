import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ProjectDetail } from './ProjectDetail'
import type { Api } from '../api/client'
import type { ProjectDetail as Detail } from '../types'

const detail: Detail = {
  project: { id: 'p1', name: 'alpha', status: 'active' },
  branches: [
    { id: 'b0', name: 'main', is_default: true, neon_branch_ref: 'br-main', status: 'active' },
    { id: 'b1', name: 'dev', is_default: false, neon_branch_ref: 'br-dev', status: 'active' },
  ],
  resources: [{ kind: 'neon', status: 'active', provider_ref: { neonProjectId: 'np-1' } }],
}

function fakeApi(overrides: Partial<Api> = {}): Api {
  return {
    listProjects: vi.fn(),
    getProject: vi.fn(async () => detail),
    createProject: vi.fn(),
    deleteProject: vi.fn(),
    createBranch: vi.fn(async () => ({})),
    deleteBranch: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as Api
}

describe('ProjectDetail', () => {
  it('renders branches and resource handles', async () => {
    render(<ProjectDetail api={fakeApi()} projectId="p1" onBack={vi.fn()} />)
    expect(await screen.findByText('main')).toBeInTheDocument()
    expect(screen.getByText('dev')).toBeInTheDocument()
    expect(screen.getByText('neon')).toBeInTheDocument()
    expect(screen.getByText(/neonProjectId=/)).toBeInTheDocument()
  })

  it('the default branch row exposes no delete control', async () => {
    render(<ProjectDetail api={fakeApi()} projectId="p1" onBack={vi.fn()} />)
    await screen.findByText('main')
    // exactly one [delete] button (for the non-default 'dev' branch)
    expect(screen.getAllByRole('button', { name: /delete/i })).toHaveLength(1)
  })

  it('deleting a non-default branch calls deleteBranch', async () => {
    const deleteBranch = vi.fn(async () => ({}))
    render(<ProjectDetail api={fakeApi({ deleteBranch })} projectId="p1" onBack={vi.fn()} />)
    await screen.findByText('dev')
    await userEvent.click(screen.getByRole('button', { name: /delete/i }))
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }))
    expect(deleteBranch).toHaveBeenCalledWith('p1', 'b1')
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

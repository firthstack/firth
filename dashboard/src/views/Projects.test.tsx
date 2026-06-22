import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Projects } from './Projects'
import type { Api } from '../api/client'

function fakeApi(overrides: Partial<Api> = {}): Api {
  return {
    listProjects: vi.fn(async () => [{ id: 'p1', name: 'alpha', status: 'active' }]),
    getProject: vi.fn(),
    createProject: vi.fn(async () => ({})),
    deleteProject: vi.fn(async () => ({})),
    createBranch: vi.fn(),
    deleteBranch: vi.fn(),
    approve: vi.fn(async () => ({})),
    ...overrides,
  } as unknown as Api
}

describe('Projects', () => {
  it('renders project names from listProjects', async () => {
    const api = fakeApi()
    render(<Projects api={api} onOpen={vi.fn()} />)
    expect(await screen.findByText('alpha')).toBeInTheDocument()
  })

  it('creating a project calls createProject then refreshes', async () => {
    const listProjects = vi.fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 'p2', name: 'beta', status: 'active' }])
    const createProject = vi.fn(async () => ({}))
    const api = fakeApi({ listProjects, createProject })
    render(<Projects api={api} onOpen={vi.fn()} />)
    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByRole('button', { name: /create/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'beta')
    await userEvent.click(screen.getByRole('button', { name: /^\[ok\]$/i }))
    expect(createProject).toHaveBeenCalledWith('beta')
    expect(await screen.findByText('beta')).toBeInTheDocument()
  })

  it('disables the create button while submitting and ignores a double-click', async () => {
    const listProjects = vi.fn().mockResolvedValue([])
    let finish!: () => void
    const createProject = vi.fn(() => new Promise<unknown>((res) => { finish = () => res({}) }))
    const api = fakeApi({ listProjects, createProject })
    render(<Projects api={api} onOpen={vi.fn()} />)
    await waitFor(() => expect(listProjects).toHaveBeenCalledTimes(1))
    await userEvent.click(screen.getByRole('button', { name: /create/i }))
    await userEvent.type(screen.getByLabelText(/name/i), 'beta')
    await userEvent.click(screen.getByRole('button', { name: /^\[ok\]$/i }))
    // in-flight: the button now shows "creating…" and is disabled
    const btn = screen.getByRole('button', { name: /creating/i })
    expect(btn).toBeDisabled()
    expect(createProject).toHaveBeenCalledTimes(1)
    await userEvent.click(btn) // second click while submitting must be a no-op
    expect(createProject).toHaveBeenCalledTimes(1)
    finish()
    await waitFor(() => expect(createProject).toHaveBeenCalledTimes(1))
  })

  it('deleting a project shows a confirm; confirming calls deleteProject', async () => {
    const deleteProject = vi.fn(async () => ({}))
    const api = fakeApi({ deleteProject })
    render(<Projects api={api} onOpen={vi.fn()} />)
    await screen.findByText('alpha')
    await userEvent.click(screen.getByRole('button', { name: /delete/i }))
    expect(screen.getByRole('alertdialog')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }))
    expect(deleteProject).toHaveBeenCalledWith('p1')
  })

  it('disables delete + shows deleting… while a delete is in flight, ignoring repeat clicks', async () => {
    let finish!: () => void
    const deleteProject = vi.fn(() => new Promise<unknown>((res) => { finish = () => res({}) }))
    const api = fakeApi({ deleteProject })
    render(<Projects api={api} onOpen={vi.fn()} />)
    await screen.findByText('alpha')
    await userEvent.click(screen.getByRole('button', { name: /^\[delete\]$/i }))
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }))
    expect(deleteProject).toHaveBeenCalledTimes(1)
    const btn = screen.getByRole('button', { name: /deleting/i })
    expect(btn).toBeDisabled()
    await userEvent.click(btn) // repeat click while deleting must be a no-op
    expect(deleteProject).toHaveBeenCalledTimes(1)
    finish()
    await waitFor(() => expect(deleteProject).toHaveBeenCalledTimes(1))
  })

  it('a gated delete (approval_required) pops an approve prompt instead of silently doing nothing', async () => {
    const deleteProject = vi.fn(async () => ({ status: 'approval_required', approvalId: 'ap1', action: 'project.delete' }))
    const api = fakeApi({ deleteProject })
    render(<Projects api={api} onOpen={vi.fn()} />)
    await screen.findByText('alpha')
    await userEvent.click(screen.getByRole('button', { name: /^\[delete\]$/i }))
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }))
    expect(deleteProject).toHaveBeenCalledTimes(1)
    expect(await screen.findByText(/requires approval/i)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /approve & delete/i })).toBeInTheDocument()
  })

  it('approve & delete approves the request then retries the delete', async () => {
    const deleteProject = vi.fn()
      .mockResolvedValueOnce({ status: 'approval_required', approvalId: 'ap1', action: 'project.delete' })
      .mockResolvedValueOnce({ project: {}, teardown: {} })
    const approve = vi.fn(async () => ({}))
    const listProjects = vi.fn()
      .mockResolvedValueOnce([{ id: 'p1', name: 'alpha', status: 'active' }])
      .mockResolvedValue([])
    const api = fakeApi({ deleteProject, approve, listProjects })
    render(<Projects api={api} onOpen={vi.fn()} />)
    await screen.findByText('alpha')
    await userEvent.click(screen.getByRole('button', { name: /^\[delete\]$/i }))
    await userEvent.click(screen.getByRole('button', { name: /confirm/i }))
    await userEvent.click(await screen.findByRole('button', { name: /approve & delete/i }))
    await waitFor(() => expect(approve).toHaveBeenCalledWith('p1', 'ap1'))
    expect(deleteProject).toHaveBeenCalledTimes(2)
  })

  it('shows the firth project create cli hint', async () => {
    render(<Projects api={fakeApi()} onOpen={vi.fn()} />)
    await screen.findByText('alpha')
    expect(screen.getByText('firth project create <name>')).toBeInTheDocument()
  })

  it('opening a project calls onOpen with its id', async () => {
    const onOpen = vi.fn()
    const api = fakeApi()
    render(<Projects api={api} onOpen={onOpen} />)
    await screen.findByText('alpha')
    await userEvent.click(screen.getByRole('button', { name: /open/i }))
    expect(onOpen).toHaveBeenCalledWith('p1')
  })
})

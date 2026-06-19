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

  it('opening a project calls onOpen with its id', async () => {
    const onOpen = vi.fn()
    const api = fakeApi()
    render(<Projects api={api} onOpen={onOpen} />)
    await screen.findByText('alpha')
    await userEvent.click(screen.getByRole('button', { name: /open/i }))
    expect(onOpen).toHaveBeenCalledWith('p1')
  })
})

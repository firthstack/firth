import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import App from './App'
import type { Auth, AuthUser } from './auth/auth'
import type { Api } from './api/client'

const user: AuthUser = { id: 'u1', email: 'a@b.co' }

function fakeAuth(overrides: Partial<Auth> = {}): Auth {
  return {
    restore: vi.fn(async () => null),
    signIn: vi.fn(async () => ({ user, token: 'tok-1' })),
    signUp: vi.fn(async () => ({ needsVerification: false, user, token: 'tok-1' })),
    signInWithOAuth: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    ...overrides,
  }
}

function makeApi(listProjects = vi.fn(async () => [])): (g: () => string | null) => Api {
  return () => ({
    listProjects, getProject: vi.fn(async () => ({ project: { id: 'p1', name: 'alpha', status: 'active' }, branches: [], resources: [] })),
    createProject: vi.fn(), deleteProject: vi.fn(), createBranch: vi.fn(), deleteBranch: vi.fn(),
  } as unknown as Api)
}

describe('App', () => {
  it('with no restored session renders the Home landing page', async () => {
    render(<App auth={fakeAuth()} makeApi={makeApi()} />)
    // Home is shown first (not AuthScreen)
    expect(await screen.findByText(/a builder platform for agents/i)).toBeInTheDocument()
  })

  it('clicking get started on Home shows the AuthScreen', async () => {
    render(<App auth={fakeAuth()} makeApi={makeApi()} />)
    await screen.findByText(/a builder platform for agents/i)
    await userEvent.click(screen.getByRole('button', { name: /get started/i }))
    // AuthScreen is now shown
    expect(await screen.findByText(/firth \/\/ access/i)).toBeInTheDocument()
  })

  it('back button in AuthScreen returns to Home', async () => {
    render(<App auth={fakeAuth()} makeApi={makeApi()} />)
    await screen.findByText(/a builder platform for agents/i)
    await userEvent.click(screen.getByRole('button', { name: /get started/i }))
    await screen.findByText(/firth \/\/ access/i)
    await userEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(await screen.findByText(/a builder platform for agents/i)).toBeInTheDocument()
  })

  it('after sign-in renders the Projects view', async () => {
    render(<App auth={fakeAuth()} makeApi={makeApi()} />)
    // navigate to auth
    await screen.findByText(/a builder platform for agents/i)
    await userEvent.click(screen.getByRole('button', { name: /get started/i }))
    await screen.findByText(/firth \/\/ access/i)
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.co')
    await userEvent.type(screen.getByLabelText(/password/i), 'pw')
    await userEvent.click(screen.getByTestId('auth-submit'))
    expect(await screen.findByText(/projects/i)).toBeInTheDocument()
  })

  it('a restored session goes straight to Projects; logout returns to Home', async () => {
    const auth = fakeAuth({ restore: vi.fn(async () => ({ user, token: 'tok-1' })) })
    render(<App auth={auth} makeApi={makeApi()} />)
    expect(await screen.findByText(/projects/i)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: /logout/i }))
    expect(auth.signOut).toHaveBeenCalled()
    // returns to Home, not AuthScreen
    expect(await screen.findByText(/a builder platform for agents/i)).toBeInTheDocument()
  })

  it('a 401 from the api returns to the Home landing page', async () => {
    const list = vi.fn(async () => { const e: any = new Error('unauthorized'); e.status = 401; e.name = 'ApiError'; throw e })
    const auth = fakeAuth({ restore: vi.fn(async () => ({ user, token: 'tok-1' })) })
    render(<App auth={auth} makeApi={makeApi(list)} />)
    // after 401, lands on Home
    expect(await screen.findByText(/a builder platform for agents/i)).toBeInTheDocument()
  })
})

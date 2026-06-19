import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { AuthScreen } from './AuthScreen'
import type { Auth, AuthUser } from '../auth/auth'

const user: AuthUser = { id: 'u1', email: 'a@b.co' }

function fakeAuth(overrides: Partial<Auth> = {}): Auth {
  return {
    restore: vi.fn(async () => null),
    signIn: vi.fn(async () => ({ user, token: 'tok-1' })),
    signUp: vi.fn(async () => ({ needsVerification: false, user, token: 'tok-1' })),
    resendVerification: vi.fn(async () => {}),
    signOut: vi.fn(async () => {}),
    ...overrides,
  }
}

describe('AuthScreen', () => {
  it('signing in calls onAuthed with the token and user', async () => {
    const auth = fakeAuth()
    const onAuthed = vi.fn()
    render(<AuthScreen auth={auth} onAuthed={onAuthed} />)
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.co')
    await userEvent.type(screen.getByLabelText(/password/i), 'pw')
    await userEvent.click(screen.getByTestId('auth-submit'))
    expect(auth.signIn).toHaveBeenCalledWith('a@b.co', 'pw')
    expect(onAuthed).toHaveBeenCalledWith('tok-1', user)
  })

  it('sign-up needing verification shows a verify message and does NOT call onAuthed', async () => {
    const auth = fakeAuth({ signUp: vi.fn(async () => ({ needsVerification: true })) })
    const onAuthed = vi.fn()
    render(<AuthScreen auth={auth} onAuthed={onAuthed} />)
    await userEvent.click(screen.getByRole('button', { name: /create account/i }))
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.co')
    await userEvent.type(screen.getByLabelText(/password/i), 'pw')
    await userEvent.click(screen.getByTestId('auth-submit'))
    expect(await screen.findByText(/check your email/i)).toBeInTheDocument()
    expect(onAuthed).not.toHaveBeenCalled()
  })

  it('a failed sign-in renders a terminal error line', async () => {
    const auth = fakeAuth({ signIn: vi.fn(async () => { throw new Error('sign-in failed') }) })
    const onAuthed = vi.fn()
    render(<AuthScreen auth={auth} onAuthed={onAuthed} />)
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.co')
    await userEvent.type(screen.getByLabelText(/password/i), 'pw')
    await userEvent.click(screen.getByTestId('auth-submit'))
    expect(await screen.findByText(/sign-in failed/i)).toBeInTheDocument()
    expect(onAuthed).not.toHaveBeenCalled()
  })

  it('a failed sign-in offers a resend-verification button that calls resendVerification', async () => {
    const resendVerification = vi.fn(async () => {})
    const auth = fakeAuth({ signIn: vi.fn(async () => { throw new Error('email not verified') }), resendVerification })
    render(<AuthScreen auth={auth} onAuthed={vi.fn()} />)
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.co')
    await userEvent.type(screen.getByLabelText(/password/i), 'pw')
    await userEvent.click(screen.getByTestId('auth-submit'))
    const resendBtn = await screen.findByTestId('resend-verification')
    await userEvent.click(resendBtn)
    expect(resendVerification).toHaveBeenCalledWith('a@b.co')
    expect(await screen.findByText(/verification link sent to a@b\.co/i)).toBeInTheDocument()
  })

  it('sign-up needing verification also offers the resend button', async () => {
    const auth = fakeAuth({ signUp: vi.fn(async () => ({ needsVerification: true })) })
    render(<AuthScreen auth={auth} onAuthed={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /create account/i }))
    await userEvent.type(screen.getByLabelText(/email/i), 'a@b.co')
    await userEvent.type(screen.getByLabelText(/password/i), 'pw')
    await userEvent.click(screen.getByTestId('auth-submit'))
    expect(await screen.findByTestId('resend-verification')).toBeInTheDocument()
  })
})

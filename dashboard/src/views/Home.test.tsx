import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Home } from './Home'

describe('Home', () => {
  it('renders the firth wordmark', () => {
    render(<Home onGetStarted={vi.fn()} />)
    expect(screen.getByTestId('firth-banner')).toBeInTheDocument()
  })

  it('leads with the branchable & governable positioning', () => {
    render(<Home onGetStarted={vi.fn()} />)
    expect(screen.getByText(/branchable & governable infrastructure for agents/i)).toBeInTheDocument()
  })

  it('renders the core features incl. CoW postgres', () => {
    render(<Home onGetStarted={vi.fn()} />)
    expect(screen.getByText('• CoW postgres')).toBeInTheDocument()
  })

  it('renders the how-it-works lifecycle', () => {
    render(<Home onGetStarted={vi.fn()} />)
    expect(screen.getByText('$ firth --how')).toBeInTheDocument()
    expect(screen.getByText(/firth branch create/i)).toBeInTheDocument()
  })

  it('shows how to install the firth cli', () => {
    render(<Home onGetStarted={vi.fn()} />)
    expect(screen.getByText('$ firth --install')).toBeInTheDocument()
    expect(screen.getByText('npm install -g firth')).toBeInTheDocument()
  })

  it('clicking get started calls onGetStarted', async () => {
    const onGetStarted = vi.fn()
    render(<Home onGetStarted={onGetStarted} />)
    await userEvent.click(screen.getByRole('button', { name: /get started/i }))
    expect(onGetStarted).toHaveBeenCalledOnce()
  })
})

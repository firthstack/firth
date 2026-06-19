import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Home } from './Home'

describe('Home', () => {
  it('renders the FIRTH banner', () => {
    render(<Home onGetStarted={vi.fn()} />)
    // The ASCII banner contains the word FIRTH
    expect(screen.getByTestId('firth-banner')).toBeInTheDocument()
  })

  it('renders the tagline', () => {
    render(<Home onGetStarted={vi.fn()} />)
    expect(screen.getByText(/a builder platform for agents/i)).toBeInTheDocument()
  })

  it('renders feature lines from the faux terminal', () => {
    render(<Home onGetStarted={vi.fn()} />)
    expect(screen.getByText(/unified secrets/i)).toBeInTheDocument()
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

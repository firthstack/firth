import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { Panel, CliHint } from './Terminal'

describe('Terminal primitives', () => {
  it('Panel renders its title and children', () => {
    render(<Panel title="PROJECTS">x</Panel>)
    expect(screen.getByText('PROJECTS')).toBeInTheDocument()
    expect(screen.getByText('x')).toBeInTheDocument()
  })
})

describe('CliHint', () => {
  beforeEach(() => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn(async () => {}) } })
  })

  it('renders the command and optional note', () => {
    render(<CliHint command="firth project create my-app" note="# provisions resources" />)
    expect(screen.getByText('firth project create my-app')).toBeInTheDocument()
    expect(screen.getByText('# provisions resources')).toBeInTheDocument()
  })

  it('copies the command to the clipboard on click', async () => {
    render(<CliHint command="firth branch create dev" />)
    await userEvent.click(screen.getByRole('button', { name: /copy command/i }))
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('firth branch create dev')
  })
})

import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Panel } from './Terminal'

describe('Terminal primitives', () => {
  it('Panel renders its title and children', () => {
    render(<Panel title="PROJECTS">x</Panel>)
    expect(screen.getByText('PROJECTS')).toBeInTheDocument()
    expect(screen.getByText('x')).toBeInTheDocument()
  })
})

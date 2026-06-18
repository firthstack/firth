import { expect, test } from 'vitest'
import { version } from '../src/index.js'

test('package exposes a version string', () => {
  expect(version).toBe('0.0.0')
})

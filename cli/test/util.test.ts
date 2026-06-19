import { expect, test } from 'vitest'
import { formatTeardown } from '../src/commands/util.js'

test('empty object returns empty string', () => {
  expect(formatTeardown({})).toBe('')
})

test('destroyed only returns correct string', () => {
  expect(formatTeardown({ destroyed: ['neon', 'fly'] })).toBe(' (destroyed: neon, fly)')
})

test('both destroyed and failed returns both parts', () => {
  expect(formatTeardown({ destroyed: ['neon'], failed: [{ kind: 's3' }] })).toBe(' (destroyed: neon); FAILED: s3')
})

test('empty arrays return empty string', () => {
  expect(formatTeardown({ destroyed: [], failed: [] })).toBe('')
})

test('destroyed and multiple failed items', () => {
  expect(formatTeardown({ destroyed: ['neon', 'fly'], failed: [{ kind: 's3' }, { kind: 'rds' }] })).toBe(' (destroyed: neon, fly); FAILED: s3, rds')
})

test('failed only returns failed part', () => {
  expect(formatTeardown({ failed: [{ kind: 'dynamodb' }] })).toBe('FAILED: dynamodb')
})

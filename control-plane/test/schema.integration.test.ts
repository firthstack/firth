import { execFileSync } from 'node:child_process'
import { expect, test } from 'vitest'

function query(sql: string): any[] {
  const out = execFileSync('npx', ['@insforge/cli', 'db', 'query', sql, '--json'],
    { cwd: '..', encoding: 'utf8' })
  return JSON.parse(out).rows
}

test('all four firth-core tables exist', () => {
  const rows = query(
    "select table_name from information_schema.tables where table_schema='public' " +
    "and table_name in ('projects','branches','resources','secrets')")
  expect(rows.map((r) => r.table_name).sort())
    .toEqual(['branches', 'projects', 'resources', 'secrets'])
})

test('RLS is enabled on every metadata table', () => {
  const rows = query(
    "select relname from pg_class where relrowsecurity=true and relname in " +
    "('projects','branches','resources','secrets')")
  expect(rows.length).toBe(4)
})

test('every owner-policy carries USING and WITH CHECK', () => {
  const rows = query(
    "select policyname, qual, with_check from pg_policies where schemaname='public' and tablename in ('projects','branches','resources','secrets')")
  expect(rows.length).toBeGreaterThanOrEqual(4)
  for (const r of rows) {
    expect(r.qual, `${r.policyname} USING`).not.toBeNull()
    expect(r.with_check, `${r.policyname} WITH CHECK`).not.toBeNull()
  }
})

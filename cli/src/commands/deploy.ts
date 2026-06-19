import { parseArgs } from 'node:util'
import { readProjectLink } from '../config.js'
import { apiFromDeps } from './project.js'
import type { CliDeps } from '../index.js'
import type { FirthApi } from '../api.js'

export async function deploy(argv: string[], deps: CliDeps & { makeApi?: () => FirthApi }): Promise<number> {
  const { values } = parseArgs({ args: argv, options: {
    image: { type: 'string' }, from: { type: 'string' }, port: { type: 'string' },
  }, allowPositionals: false })
  if (!values.image) { deps.print('usage: firth deploy --image <url> [--from <branch>] [--port <n>]'); return 1 }
  const link = readProjectLink(deps.cwd)
  if (!link) { deps.print('this directory is not linked — run `firth project link <id>`'); return 1 }
  const out = await apiFromDeps(deps).deploy(link.projectId, {
    image: values.image,
    from: values.from,
    branch: link.branch?.id ?? link.branch?.name,
    port: values.port ? Number(values.port) : undefined,
  })
  deps.print(`deployed machine ${out.machineId} → ${out.url}`)
  return 0
}

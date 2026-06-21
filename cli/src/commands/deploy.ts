import { existsSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parseArgs } from 'node:util'
import { readProjectLink } from '../config.js'
import { ensureFlyctl } from '../fly.js'
import { flyctlBuildAndPush, defaultBuildRunner, type BuildRunner } from '../flyctl-build.js'
import { apiFromDeps } from './project.js'
import type { CliDeps } from '../index.js'
import type { FirthApi } from '../api.js'

export async function deploy(argv: string[], deps: CliDeps & { makeApi?: () => FirthApi; buildRunner?: BuildRunner }): Promise<number> {
  const { values, positionals } = parseArgs({ args: argv, options: {
    image: { type: 'string' }, from: { type: 'string' }, port: { type: 'string' },
  }, allowPositionals: true })
  const dir = positionals[0]

  if (dir && values.image) { deps.print('pick one mode: a source <dir> OR --image <url>, not both'); return 1 }
  if (!dir && !values.image) { deps.print('usage: firth deploy <dir> | --image <url>  [--from <branch>] [--port <n>]'); return 1 }

  const link = readProjectLink(deps.cwd)
  if (!link) { deps.print('this directory is not linked — run `firth project link <id>`'); return 1 }
  const from = values.from
  const branch = link.branch?.id ?? link.branch?.name

  // ─── Image mode (unchanged) ───────────────────────────────────────────
  if (!dir) {
    const out = await apiFromDeps(deps).deploy(link.projectId, {
      image: values.image!, from, branch, port: values.port ? Number(values.port) : undefined,
    })
    deps.print(`deployed machine ${out.machineId} → ${out.url}`)
    return 0
  }

  // ─── Source mode ──────────────────────────────────────────────────────
  const absDir = resolve(deps.cwd, dir)
  if (!existsSync(join(absDir, 'Dockerfile'))) {
    deps.print(`no Dockerfile at ${join(absDir, 'Dockerfile')} — create one, or use --image <url>`)
    return 1
  }
  await ensureFlyctl(deps)
  const port = values.port ? Number(values.port) : 8080
  const api = apiFromDeps(deps)
  const { token, flyApp } = await api.mintDeployToken(link.projectId, { from, branch })
  const { imageRef } = await flyctlBuildAndPush(
    { dir: absDir, flyApp, imageLabel: `cli-${Date.now()}`, token, port },
    deps.buildRunner ?? defaultBuildRunner,
  )
  const out = await api.deploy(link.projectId, { image: imageRef, from, branch, port })
  deps.print(`deployed machine ${out.machineId} → ${out.url}`)
  deps.print(`image: ${imageRef} (built remotely)`)
  return 0
}

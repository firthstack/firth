import { parseArgs } from 'node:util'
import { FirthApi } from '../api.js'
import { readConfig, writeConfig } from '../config.js'
import type { CliDeps } from '../index.js'

export async function login(argv: string[], deps: CliDeps & { makeApi?: () => Pick<FirthApi, 'login'> }): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { email: { type: 'string' }, password: { type: 'string' } }, allowPositionals: false })
  const email = values.email ?? deps.env.FIRTH_EMAIL
  const password = values.password ?? deps.env.FIRTH_PASSWORD
  if (!email || !password) { deps.print('login requires --email and --password (or FIRTH_EMAIL/FIRTH_PASSWORD)'); return 1 }
  const cfg = readConfig(deps.home, deps.env)
  const api = deps.makeApi ? deps.makeApi() : new FirthApi(cfg.apiUrl, '')
  try {
    const { token } = await api.login(email, password)
    writeConfig({ ...cfg, token }, deps.home)
    deps.print(`signed in as ${email}`)
    return 0
  } catch (e) {
    deps.print(`login failed: ${e instanceof Error ? e.message : String(e)}`)
    return 1
  }
}

export async function logout(_argv: string[], deps: CliDeps): Promise<number> {
  const cfg = readConfig(deps.home, deps.env)
  delete cfg.token
  writeConfig(cfg, deps.home)
  deps.print('signed out')
  return 0
}

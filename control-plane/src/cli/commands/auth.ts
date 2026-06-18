import { parseArgs } from 'node:util'
import { createClient } from '@insforge/sdk'
import { readConfig, writeConfig } from '../config.js'
import type { CliDeps } from '../index.js'

export type SignIn = (baseUrl: string, anonKey: string, email: string, password: string) => Promise<{ accessToken: string }>

// Default: real InsForge auth. signInWithPassword returns { data: { accessToken }, error } (@insforge/sdk).
const defaultSignIn: SignIn = async (baseUrl, anonKey, email, password) => {
  const c = createClient({ baseUrl, anonKey })
  const { data, error } = await c.auth.signInWithPassword({ email, password })
  if (error) throw error
  if (!data?.accessToken) throw new Error('sign-in returned no access token (email verification may be required)')
  return { accessToken: data.accessToken }
}

export async function login(argv: string[], deps: CliDeps & { signIn?: SignIn }): Promise<number> {
  const { values } = parseArgs({ args: argv, options: { email: { type: 'string' }, password: { type: 'string' } }, allowPositionals: false })
  const email = values.email ?? deps.env.FIRTH_EMAIL
  const password = values.password ?? deps.env.FIRTH_PASSWORD
  if (!email || !password) { deps.print('login requires --email and --password (or FIRTH_EMAIL/FIRTH_PASSWORD)'); return 1 }
  const cfg = readConfig(deps.home, deps.env)
  const baseUrl = cfg.insforge?.baseUrl ?? deps.env.INSFORGE_BASE_URL
  const anonKey = cfg.insforge?.anonKey ?? deps.env.INSFORGE_ANON_KEY
  if (!baseUrl || !anonKey) { deps.print('missing InsForge baseUrl/anonKey (set in ~/.firth/config.json or env)'); return 1 }
  const signIn = deps.signIn ?? defaultSignIn
  try {
    const { accessToken } = await signIn(baseUrl, anonKey, email, password)
    writeConfig({ ...cfg, insforge: { baseUrl, anonKey }, token: accessToken }, deps.home)
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

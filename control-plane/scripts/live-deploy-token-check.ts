import { FlyAdapter } from '../src/adapters/fly.js'
import { fetchHttp } from '../src/adapters/factory.js'

async function main() {
  const token = process.env.FLY_API_TOKEN
  const orgSlug = process.env.FLY_ORG_SLUG
  if (!token || !orgSlug) {
    console.log('SKIP: FLY_API_TOKEN or FLY_ORG_SLUG not set — live deploy-token checkpoint skipped.')
    return
  }
  const adapter = new FlyAdapter(token, orgSlug, fetchHttp)
  const name = `firth-live-tok-${process.env.LIVE_TAG ?? 'manual'}`
  console.log(`provisioning Fly app "${name}" ...`)
  const handle = await adapter.provision(name)
  try {
    const { token: deployTok, expirySeconds } = await adapter.mintDeployToken(handle, { expirySeconds: 1200 })
    if (!deployTok.startsWith('FlyV1')) throw new Error(`unexpected token prefix: ${deployTok.slice(0, 8)}…`)
    console.log(`minted app-scoped deploy token (len ${deployTok.length}, expiry ${expirySeconds}s) ✓`)
  } finally {
    await adapter.destroy(handle)
    console.log('destroyed app (cleanup) ✓')
  }
}

main().catch((e) => { console.error('live deploy-token check failed:', e.message); process.exit(1) })

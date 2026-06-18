import { FlyAdapter } from '../src/adapters/fly.js'
import { fetchHttp } from '../src/adapters/factory.js'

async function main() {
  const token = process.env.FLY_API_TOKEN
  const orgSlug = process.env.FLY_ORG_SLUG

  if (!token || !orgSlug) {
    console.log('SKIP: FLY_API_TOKEN or FLY_ORG_SLUG not set — live Fly provisioning checkpoint skipped.')
    return
  }

  const adapter = new FlyAdapter(token, orgSlug, fetchHttp)
  const name = `firth-live-check-${process.env.LIVE_TAG ?? 'manual'}`

  console.log(`provisioning Fly app "${name}" ...`)
  const handle = await adapter.provision(name)
  try {
    console.log('provisioned:', handle.providerRef)
  } finally {
    await adapter.destroy(handle)
    console.log('destroyed app (cleanup) ✓')
  }
}

main().catch((e) => {
  console.error('live check failed:', e.message)
  process.exit(1)
})

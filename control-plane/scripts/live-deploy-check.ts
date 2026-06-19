import { FlyAdapter } from '../src/adapters/fly.js'
import { fetchHttp } from '../src/adapters/factory.js'

async function main() {
  const token = process.env.FLY_API_TOKEN
  const orgSlug = process.env.FLY_ORG_SLUG

  if (!token || !orgSlug) {
    console.log('SKIP: FLY_API_TOKEN/FLY_ORG_SLUG not set — live deploy checkpoint skipped.')
    return
  }

  const adapter = new FlyAdapter(token, orgSlug, fetchHttp)
  const tag = process.env.LIVE_TAG ?? 'manual'
  const name = `firth-live-deploy-${tag}`

  console.log(`provisioning Fly app "${name}" ...`)
  const handle = await adapter.provision(name)
  console.log('provisioned:', (handle.providerRef as { flyApp: string }).flyApp)

  try {
    console.log('deploying image flyio/hellofly:latest ...')
    const res = await adapter.deploy(handle, {
      image: 'flyio/hellofly:latest',
      env: { FIRTH_DEMO: '1' },
      port: 8080,
    })
    console.log('deployed machine:', res.machineId, '→', res.url)
  } finally {
    await adapter.destroy(handle)
    console.log('destroyed app (cleanup) ✓')
  }
}

main().catch((e) => {
  console.error('live deploy failed:', e.message)
  process.exit(1)
})

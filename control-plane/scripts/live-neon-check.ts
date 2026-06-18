import { NeonAdapter } from '../src/adapters/neon.js'
import { fetchHttp } from '../src/adapters/factory.js'

async function main() {
  const key = process.env.NEON_API_KEY
  if (!key) {
    console.log('SKIP: NEON_API_KEY not set — live Neon provisioning checkpoint skipped.')
    return
  }
  const adapter = new NeonAdapter(key, fetchHttp)
  const name = `firth-live-check-${process.env.LIVE_TAG ?? 'manual'}`
  console.log(`provisioning Neon project "${name}" ...`)
  const handle = await adapter.provision(name)
  try {
    console.log('provisioned:', handle.providerRef)
    const branch = await adapter.createBranch(handle, 'feature-check')
    console.log('created branch:', branch)
    if (branch) {
      await adapter.deleteBranch(handle, branch)
      console.log('deleted branch:', branch)
    }
    const creds = await adapter.mintCredentials(handle)
    console.log('minted DATABASE_URL present:', Boolean(creds.DATABASE_URL), '(value not printed)')
  } finally {
    await adapter.destroy(handle)
    console.log('destroyed project (cleanup) ✓')
  }
}

main().catch((e) => { console.error('live check failed:', e.message); process.exit(1) })

import { TigrisAdapter } from '../src/adapters/tigris.js'
import { makeSignedHttp } from '../src/adapters/signed-http.js'

async function main() {
  const accessKeyId = process.env.TIGRIS_ACCESS_KEY_ID
  const secretAccessKey = process.env.TIGRIS_SECRET_ACCESS_KEY

  if (!accessKeyId || !secretAccessKey) {
    console.log('SKIP: TIGRIS_ACCESS_KEY_ID or TIGRIS_SECRET_ACCESS_KEY not set — live Tigris provisioning checkpoint skipped.')
    return
  }

  const s3 = makeSignedHttp({ accessKeyId, secretAccessKey, region: 'auto', service: 's3' })
  const iam = makeSignedHttp({ accessKeyId, secretAccessKey, region: 'auto', service: 'iam' })
  const adapter = new TigrisAdapter(s3, iam)
  const name = `firth-live-check-${process.env.LIVE_TAG ?? 'manual'}`

  console.log(`provisioning Tigris bucket "${name}" ...`)
  const handle = await adapter.provision(name)
  try {
    console.log('provisioned:', handle.providerRef)
    const creds = await adapter.mintCredentials(handle)
    console.log('minted AWS_ACCESS_KEY_ID present:', Boolean(creds.AWS_ACCESS_KEY_ID), '(value not printed)')
  } finally {
    await adapter.destroy(handle)
    console.log('destroyed bucket (cleanup) ✓')
  }
}

main().catch((e) => {
  console.error('live check failed:', e.message)
  process.exit(1)
})

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
    console.log('policyArn in providerRef:', Boolean((handle.providerRef as any).policyArn), '(value not printed)')

    // --- Scoping end-to-end verification ---
    const mintedS3 = makeSignedHttp({
      accessKeyId: creds.AWS_ACCESS_KEY_ID,
      secretAccessKey: creds.AWS_SECRET_ACCESS_KEY,
      region: 'auto',
      service: 's3',
    })
    const ownBucket = creds.BUCKET_NAME
    const testKey = `firth-scope-test-${Date.now()}`

    // PUT an object into the project's own bucket — expect 2xx
    const putOwnRes = await mintedS3(`${creds.AWS_ENDPOINT_URL_S3}/${ownBucket}/${testKey}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: 'firth-scope-check',
    })
    console.log(`PUT own bucket (${ownBucket}) → status ${putOwnRes.status}`, putOwnRes.status >= 200 && putOwnRes.status < 300 ? 'PASS' : 'FAIL')

    // GET the object back — expect 2xx
    const getOwnRes = await mintedS3(`${creds.AWS_ENDPOINT_URL_S3}/${ownBucket}/${testKey}`, { method: 'GET' })
    console.log(`GET own bucket (${ownBucket}) → status ${getOwnRes.status}`, getOwnRes.status >= 200 && getOwnRes.status < 300 ? 'PASS' : 'FAIL')

    // PUT to a DIFFERENT bucket — expect 403 / AccessDenied
    const otherBucket = `firth-scope-other-${Date.now()}`
    const putOtherRes = await mintedS3(`${creds.AWS_ENDPOINT_URL_S3}/${otherBucket}/${testKey}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/plain' },
      body: 'should-be-denied',
    })
    const crossBucketDenied = putOtherRes.status === 403 || putOtherRes.status === 401
    console.log(`PUT cross-bucket (${otherBucket}) → status ${putOtherRes.status}`, crossBucketDenied ? 'PASS (denied as expected)' : 'FAIL (expected 403/AccessDenied)')
  } finally {
    await adapter.destroy(handle)
    console.log('destroyed key + policy + bucket (cleanup) ✓')
  }
}

main().catch((e) => {
  console.error('live check failed:', e.message)
  process.exit(1)
})

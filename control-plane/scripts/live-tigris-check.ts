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
    // We create a real second bucket with the admin signer so a non-existent bucket cannot mask a scoping failure.
    const otherBucket = `firth-scope-other-${process.env.LIVE_TAG ?? Date.now()}`
    console.log(`creating second bucket "${otherBucket}" with admin signer for cross-bucket denial test ...`)
    const createOtherRes = await s3(`${creds.AWS_ENDPOINT_URL_S3}/${otherBucket}`, { method: 'PUT' })
    if (createOtherRes.status < 200 || createOtherRes.status >= 300) {
      console.log(`SKIP cross-bucket denial test: could not create other bucket (status ${createOtherRes.status})`)
    } else {
      try {
        const putOtherRes = await mintedS3(`${creds.AWS_ENDPOINT_URL_S3}/${otherBucket}/${testKey}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'text/plain' },
          body: 'should-be-denied',
        })
        if (putOtherRes.status === 403 || putOtherRes.status === 401) {
          console.log(`PUT cross-bucket (${otherBucket}) → status ${putOtherRes.status} PASS (denied as expected)`)
        } else if (putOtherRes.status >= 200 && putOtherRes.status < 300) {
          console.log(`PUT cross-bucket (${otherBucket}) → status ${putOtherRes.status} FAIL (scoped key wrote to another bucket — scoping is broken!)`)
        } else {
          console.log(`PUT cross-bucket (${otherBucket}) → status ${putOtherRes.status} FAIL (unexpected status — expected 403)`)
        }
      } finally {
        // Empty and delete the other bucket with the admin signer
        try {
          const listRes = await s3(`${creds.AWS_ENDPOINT_URL_S3}/${otherBucket}?list-type=2`, { method: 'GET' })
          if (listRes.status >= 200 && listRes.status < 300) {
            const listXml = await listRes.text()
            const keyRegex = /<Key>([^<]+)<\/Key>/g
            let km: RegExpExecArray | null
            while ((km = keyRegex.exec(listXml)) !== null) {
              const encodedKey = km[1].split('/').map(encodeURIComponent).join('/')
              await s3(`${creds.AWS_ENDPOINT_URL_S3}/${otherBucket}/${encodedKey}`, { method: 'DELETE' })
            }
          }
          await s3(`${creds.AWS_ENDPOINT_URL_S3}/${otherBucket}`, { method: 'DELETE' })
          console.log(`deleted other bucket "${otherBucket}" (cleanup) ✓`)
        } catch (cleanupErr: any) {
          console.log(`warning: could not clean up other bucket "${otherBucket}": ${cleanupErr.message}`)
        }
      }
    }
  } finally {
    await adapter.destroy(handle)
    console.log('destroyed key + policy + bucket (cleanup) ✓')
  }

  await forkCheck(adapter, s3)
}

// --- Copy-on-write fork checkpoint --------------------------------------------
// Verifies the real Tigris fork behavior our offline tests can only fake:
// (1) a fork shares the parent's objects (CoW), (2) writes to the fork don't
// leak to the parent (isolation, both new + overwrite), and (3) a fork is
// itself re-forkable (the one fact the docs didn't fully settle).
async function forkCheck(adapter: TigrisAdapter, s3: ReturnType<typeof makeSignedHttp>) {
  console.log('\n=== FORK (CoW) CHECK ===')
  const tag = process.env.LIVE_TAG ?? String(Date.now())
  const endpoint = 'https://t3.storage.dev'
  const put = (bucket: string, key: string, body: string) =>
    s3(`${endpoint}/${bucket}/${key}`, { method: 'PUT', headers: { 'Content-Type': 'text/plain' }, body })
  const getText = async (bucket: string, key: string) => {
    const r = await s3(`${endpoint}/${bucket}/${key}`, { method: 'GET' })
    return { status: r.status, text: r.status >= 200 && r.status < 300 ? await r.text() : '' }
  }

  let failures = 0
  const check = (label: string, ok: boolean, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}: ${label}${detail ? ` (${detail})` : ''}`)
    if (!ok) failures++
  }

  const seed = await adapter.provision(`firth-fork-seed-${tag}`)
  const seedBucket = (seed.providerRef as any).bucket as string
  console.log(`seed bucket "${seedBucket}" snapshotEnabled=${(seed.providerRef as any).snapshotEnabled}`)
  const handles = [seed]
  try {
    const sharedKey = 'shared.txt'
    const putSeed = await put(seedBucket, sharedKey, 'from-parent')
    check('seed PUT shared object', putSeed.status >= 200 && putSeed.status < 300, `status ${putSeed.status}`)

    // fork seed → child
    const child = await adapter.forkBucket(seed, `firth-fork-child-${tag}`)
    handles.unshift(child)
    const childBucket = (child.providerRef as any).bucket as string
    console.log(`child fork "${childBucket}"`)

    // (1) CoW share: child inherits the parent's object
    const inh = await getText(childBucket, sharedKey)
    check('child inherits parent object (CoW share)', inh.status === 200 && inh.text === 'from-parent', `status ${inh.status}, body "${inh.text}"`)

    // (2a) isolation: a NEW object in the child is invisible to the parent
    await put(childBucket, 'child-only.txt', 'only-in-child')
    const leak = await getText(seedBucket, 'child-only.txt')
    check('parent does NOT see child-only object (isolation)', leak.status === 404, `status ${leak.status}`)

    // (2b) isolation: overwriting the shared object in the child leaves the parent's copy intact
    await put(childBucket, sharedKey, 'mutated-in-child')
    const parentStill = await getText(seedBucket, sharedKey)
    check('parent keeps original after child overwrite (isolation)', parentStill.text === 'from-parent', `parent body "${parentStill.text}"`)

    // (3) re-forkability: fork the child → grandchild (the key unknown)
    const grand = await adapter.forkBucket(child, `firth-fork-grand-${tag}`)
    handles.unshift(grand)
    const grandBucket = (grand.providerRef as any).bucket as string
    check('fork is itself re-forkable (grandchild created)', true, grandBucket)
    const grandInh = await getText(grandBucket, sharedKey)
    check('grandchild inherits child state', grandInh.status === 200 && grandInh.text === 'mutated-in-child', `status ${grandInh.status}, body "${grandInh.text}"`)
  } finally {
    for (const h of handles) {
      try { await adapter.destroy(h); console.log(`cleaned up "${(h.providerRef as any).bucket}" ✓`) }
      catch (e: any) { console.log(`warning: cleanup failed for "${(h.providerRef as any).bucket}": ${e.message}`) }
    }
  }

  console.log(failures === 0 ? '\nFORK CHECK: ALL PASS' : `\nFORK CHECK: ${failures} FAILURE(S)`)
  if (failures > 0) throw new Error(`fork check had ${failures} failure(s)`)
}

main().catch((e) => {
  console.error('live check failed:', e.message)
  process.exit(1)
})

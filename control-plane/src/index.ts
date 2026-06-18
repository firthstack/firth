import { loadConfig } from './config.js'
import { userClient, verifyToken } from './insforge.js'
import { buildServer } from './server.js'
import { buildAdapters } from './adapters/factory.js'

export const version = '0.0.0'

export async function main() {
  const cfg = loadConfig(process.env)
  const app = buildServer({
    cfg,
    verifyToken: (token) => verifyToken(cfg, token),
    dataForToken: (token) => userClient(cfg, token).database,
    adaptersForToken: () => buildAdapters(cfg),
  })
  const port = Number(process.env.PORT ?? 8080)
  await app.listen({ port, host: '0.0.0.0' })
  console.log(`firth control-plane listening on :${port}`)
}

if (process.env.NODE_ENV !== 'test') {
  main().catch((e) => { console.error('startup failed:', e.message); process.exit(1) })
}

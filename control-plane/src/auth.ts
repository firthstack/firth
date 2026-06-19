export class UnauthorizedError extends Error {
  constructor(msg = 'unauthorized') { super(msg); this.name = 'UnauthorizedError' }
}

export class NotFoundError extends Error {
  constructor(msg = 'not found') { super(msg); this.name = 'NotFoundError' }
}

export async function resolveUid(
  authHeader: string | undefined,
  verify: (token: string) => Promise<{ id: string } | null>,
): Promise<{ uid: string; token: string }> {
  if (!authHeader?.startsWith('Bearer ')) throw new UnauthorizedError('missing bearer token')
  const token = authHeader.slice('Bearer '.length).trim()
  if (!token) throw new UnauthorizedError('empty token')
  const user = await verify(token)
  if (!user) throw new UnauthorizedError('invalid token')
  return { uid: user.id, token }
}

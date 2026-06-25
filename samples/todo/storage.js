import {
  S3Client, PutObjectCommand, DeleteObjectCommand, DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import { randomUUID } from 'node:crypto'

export const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024

const EXT_BY_TYPE = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
}

export function contentTypeToExt(type) {
  const ext = EXT_BY_TYPE[type]
  if (!ext) throw new Error(`unsupported image type: ${type}`)
  return ext
}

// The S3 gateway endpoint is `<host>/storage/v1/s3`; public objects are served off the host root.
export function publicBaseFromEndpoint(endpoint) {
  return String(endpoint ?? '').replace(/\/storage\/v1\/s3\/?$/, '').replace(/\/$/, '')
}

export function makeStorage(env = process.env, client) {
  const bucket = env.BUCKET_NAME
  const base = publicBaseFromEndpoint(env.AWS_ENDPOINT_URL_S3)
  const s3 = client ?? new S3Client({
    endpoint: env.AWS_ENDPOINT_URL_S3,
    region: env.AWS_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  })

  // NOTE: this URL shape is verified live in Task 2; adjust here + the publicUrl test if it differs.
  const publicUrl = (key) => `${base}/api/storage/buckets/${bucket}/objects/${key}`

  return {
    publicUrl,
    async uploadImage(buffer, contentType) {
      const key = `todos/${randomUUID()}.${contentTypeToExt(contentType)}`
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: buffer, ContentType: contentType,
      }))
      return { key, url: publicUrl(key) }
    },
    async deleteImage(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    },
    async deleteImages(keys) {
      if (!keys || keys.length === 0) return
      await s3.send(new DeleteObjectsCommand({
        Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })) },
      }))
    },
  }
}

import {
  S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, DeleteObjectsCommand,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { randomUUID } from 'node:crypto'

export const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024
export const IMAGE_URL_TTL_SECONDS = 3600

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

export function makeStorage(env = process.env, client) {
  const bucket = env.BUCKET_NAME
  const s3 = client ?? new S3Client({
    endpoint: env.AWS_ENDPOINT_URL_S3,
    region: env.AWS_REGION,
    forcePathStyle: true,
    credentials: {
      accessKeyId: env.AWS_ACCESS_KEY_ID,
      secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    },
  })

  return {
    async uploadImage(buffer, contentType) {
      const key = `todos/${randomUUID()}.${contentTypeToExt(contentType)}`
      await s3.send(new PutObjectCommand({
        Bucket: bucket, Key: key, Body: buffer, ContentType: contentType,
      }))
      return { key }
    },
    // Short-lived presigned GET URL — the only way the (private) object is reached. Local crypto.
    async presignedGetUrl(key, expiresIn = IMAGE_URL_TTL_SECONDS) {
      return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn })
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

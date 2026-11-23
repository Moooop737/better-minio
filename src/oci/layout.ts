/**
 * registry 桶布局 + digest / tag 语法 —— 全模块共用的纯函数（design §二）。
 *   blobs/sha256/<hex>        blob 与 manifest（内容寻址，不可变）
 *   repos/<name>/index.json   每 repo 索引（tags / manifests / blobs）
 *   uploads/<uuid>/chunk-<n>  上传会话临时 chunk；uploads/<uuid>/final 收尾临时对象
 * 只支持 sha256（distribution 必备算法）；其他算法 → DIGEST_INVALID。
 */

export {
  parseDigest,
  isTag,
  isDigestRef,
  blobKey,
  indexKey,
  uploadPrefix,
  chunkKey,
  finalKey,
  UPLOADS_PREFIX,
  UPLOAD_ID_RE,
  SESSION_PREFIX,
  sessionKey,
}

import { ociError } from './errors'

const DIGEST_RE = /^sha256:([a-f0-9]{64})$/
/* 通用 digest 语法（algorithm:encoded），用于区分「是 digest 但算法不支持」与「是 tag」 */
const ANY_DIGEST_RE = /^[a-z0-9]+(?:[+._-][a-z0-9]+)*:[a-zA-Z0-9=_-]+$/
const TAG_RE = /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const UPLOADS_PREFIX = 'uploads/'
const SESSION_PREFIX = 'better-minio:oci:upload:'

/* 合法 sha256 digest → hex；否则抛 DIGEST_INVALID */
function parseDigest(Raw: string | undefined): { digest: string; hex: string } {
  const Match = Raw === undefined ? null : DIGEST_RE.exec(Raw)
  if (Match?.[1] === undefined) throw ociError('DIGEST_INVALID', 'digest 格式非法或算法不支持（仅 sha256）')
  return { digest: `sha256:${Match[1]}`, hex: Match[1] }
}

function isDigestRef(Ref: string): boolean {
  return ANY_DIGEST_RE.test(Ref) && Ref.includes(':')
}

function isTag(Ref: string): boolean {
  return TAG_RE.test(Ref)
}

function blobKey(Hex: string): string {
  return `blobs/sha256/${Hex}`
}

function indexKey(Name: string): string {
  return `repos/${Name}/index.json`
}

function uploadPrefix(Uuid: string): string {
  return `${UPLOADS_PREFIX}${Uuid}/`
}

function chunkKey(Uuid: string, N: number): string {
  return `${UPLOADS_PREFIX}${Uuid}/chunk-${N}`
}

function finalKey(Uuid: string): string {
  return `${UPLOADS_PREFIX}${Uuid}/final`
}

function sessionKey(Uuid: string): string {
  return `${SESSION_PREFIX}${Uuid}`
}

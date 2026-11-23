/**
 * presign 边界校验（zod v4，边界一次 parse）—— put/get 两份请求体 schema，及可复用的字段 schema。
 * multipart / proxy 控制端点 import `keySchema` / `clientIpSchema` / `expiresInSchema` / `parseJsonBody`，保证同一口径。
 * client_ip 用 auth 的 normalizeIp 规范化（`::ffff:` 映射 → IPv4），与数据面闸比对侧同规则。
 */

export { keySchema, clientIpSchema, expiresInSchema, presignPutSchema, presignGetSchema, formatIssues, parseJsonBody }
export type { PresignPutInput, PresignGetInput }

import type { Context } from 'hono'
import { z } from 'zod'
import { GatewayError } from '../core/errors'
import { normalizeIp } from '../auth/client-ip'
import { PRESIGN_MAX_SECONDS, PRESIGN_MIN_SECONDS } from '../api/object-store'

const KEY_MAX_BYTES = 1024
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/

const keySchema = z
  .string()
  .min(1, 'key 不能为空')
  .refine((Key) => Buffer.byteLength(Key, 'utf8') <= KEY_MAX_BYTES, 'key 超过 1024 字节')
  .refine((Key) => !Key.startsWith('/'), 'key 不能以 / 开头')
  .refine((Key) => !CONTROL_CHAR_RE.test(Key), 'key 不能含控制字符')

const expiresInSchema = z.number().int('expiresIn 需为整数').min(PRESIGN_MIN_SECONDS).max(PRESIGN_MAX_SECONDS)

const clientIpSchema = z.string().transform((Raw, Ctx) => {
  const Ip = normalizeIp(Raw)
  if (Ip === null) {
    Ctx.addIssue({ code: 'custom', message: 'client_ip 不是合法 IP' })
    return z.NEVER
  }
  return Ip
})

const subSchema = z.string().min(1).max(256)
const resourceIdSchema = z.string().max(256)
const headerValueSchema = z.string().min(1).max(1024)

const presignPutSchema = z.object({
  key: keySchema,
  expiresIn: expiresInSchema,
  client_ip: clientIpSchema,
  sub: subSchema,
  resource_id: resourceIdSchema.optional(),
  contentType: headerValueSchema.optional(),
})

const presignGetSchema = z.object({
  key: keySchema,
  expiresIn: expiresInSchema,
  client_ip: clientIpSchema,
  sub: subSchema,
  resource_id: resourceIdSchema.optional(),
  responseContentDisposition: headerValueSchema.optional(),
  responseContentType: headerValueSchema.optional(),
  responseCacheControl: headerValueSchema.optional(),
})

type PresignPutInput = z.output<typeof presignPutSchema>
type PresignGetInput = z.output<typeof presignGetSchema>

/* zod 错误 → 对外 issues：只给字段路径与规则文案，不回显请求值 */
function formatIssues(Error: z.ZodError): { path: string; message: string }[] {
  return Error.issues.map((Issue) => ({ path: Issue.path.map(String).join('.'), message: Issue.message }))
}

/* JSON 解析 + zod parse；任何失败 → 400 E_VALIDATION（issues 只含字段路径，不回显值）。proxy 控制端点复用 */
async function parseJsonBody<S extends z.ZodType>(c: Context, Schema: S): Promise<z.output<S>> {
  let Body: unknown
  try {
    Body = await c.req.json()
  } catch {
    throw new GatewayError('E_VALIDATION', '请求体不是合法 JSON')
  }
  const Result = Schema.safeParse(Body)
  if (!Result.success) throw new GatewayError('E_VALIDATION', '请求参数不合法', { issues: formatIssues(Result.error) })
  return Result.data
}

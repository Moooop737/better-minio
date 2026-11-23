/**
 * complete 对账（纯函数，不碰网络）—— 输入会话 + 客户端清单 + ListParts 真源，输出三态：
 *   size_mismatch：期望集内已传片尺寸违反分法（非末片 ≠ partSize / 末片 ∉ 1..partSize），附违规编号（先于缺片判定）。
 *   incomplete：期望集（1..清单 max）内缺片（真源无 或 清单断档）→ missing；ETag 不符 → etag_mismatch（D1 视同缺片）。
 *   ready：全齐全符，parts 按编号升序（用清单 ETag）。清单外的真源片忽略（MinIO complete 丢弃）。
 * ETag 比较去引号、不分大小写。
 */

export { reconcile, normalizeEtag }
export type { ReconcileResult, MissingReason }

import type { CompletedPart, MultipartPart } from '../api/multipart'
import type { MultipartSession } from './session'

type MissingReason = 'missing' | 'etag_mismatch'

type ReconcileResult =
  | { kind: 'size_mismatch'; partNumbers: number[] }
  | { kind: 'incomplete'; missing: { partNumber: number; reason: MissingReason }[] }
  | { kind: 'ready'; parts: CompletedPart[] }

function reconcile(
  Session: Pick<MultipartSession, 'partSize'>,
  ClientParts: CompletedPart[],
  Actual: MultipartPart[],
): ReconcileResult {
  const Max = ClientParts.reduce((Acc, Part) => Math.max(Acc, Part.partNumber), 0)
  const Claimed = new Map(ClientParts.map((Part) => [Part.partNumber, Part]))
  const Stored = new Map(Actual.map((Part) => [Part.partNumber, Part]))

  const Violations: number[] = []
  for (let N = 1; N <= Max; N++) {
    const Part = Stored.get(N)
    if (Part === undefined) continue
    const Ok = N < Max ? Part.size === Session.partSize : Part.size >= 1 && Part.size <= Session.partSize
    if (!Ok) Violations.push(N)
  }
  if (Violations.length > 0) return { kind: 'size_mismatch', partNumbers: Violations }

  const Missing: { partNumber: number; reason: MissingReason }[] = []
  const Parts: CompletedPart[] = []
  for (let N = 1; N <= Max; N++) {
    const Claim = Claimed.get(N)
    const Part = Stored.get(N)
    if (Claim === undefined || Part === undefined) {
      Missing.push({ partNumber: N, reason: 'missing' })
    } else if (normalizeEtag(Claim.etag) !== normalizeEtag(Part.etag)) {
      Missing.push({ partNumber: N, reason: 'etag_mismatch' })
    } else {
      Parts.push({ partNumber: N, etag: Claim.etag })
    }
  }
  return Missing.length > 0 ? { kind: 'incomplete', missing: Missing } : { kind: 'ready', parts: Parts }
}

function normalizeEtag(Etag: string): string {
  return Etag.trim().replace(/^W\//, '').replace(/^"+|"+$/g, '').toLowerCase()
}

/**
 * 客户端 IP 提取 —— 只信可信反代的 X-Forwarded-For，否则用 TCP peer。
 * peer ∈ TRUSTED_PROXIES：XFF 从右往左找第一个不可信 IP；XFF 缺失/全可信 → null（闸判 403）。
 * peer 不可信：直接用 peer，绝不看客户端自带的 XFF。`::ffff:a.b.c.d` 规范化为 IPv4。
 */

export { resolveClientIp, normalizeIp, ipInCidrs }

import { isIP } from 'node:net'
import { ipToBigInt, maskAddress } from '../config'
import type { Cidr } from '../config'

function resolveClientIp(RemoteAddress: string | undefined, Xff: string | undefined, Trusted: Cidr[]): string | null {
  const Peer = RemoteAddress === undefined ? null : normalizeIp(RemoteAddress)
  if (Peer === null) return null
  if (!ipInCidrs(Peer, Trusted)) return Peer
  if (Xff === undefined || Xff.trim() === '') return null
  const Hops = Xff.split(',').map((Hop) => Hop.trim())
  for (let Index = Hops.length - 1; Index >= 0; Index--) {
    const Hop = normalizeIp(Hops[Index] ?? '')
    if (Hop === null) return null
    if (!ipInCidrs(Hop, Trusted)) return Hop
  }
  return null
}

function normalizeIp(Raw: string): string | null {
  let Value = Raw.trim()
  if (Value.startsWith('[') && Value.endsWith(']')) Value = Value.slice(1, -1)
  const Zone = Value.indexOf('%')
  if (Zone !== -1) Value = Value.slice(0, Zone)
  const Family = isIP(Value)
  if (Family === 0) return null
  if (Family === 4) return Value
  const Lower = Value.toLowerCase()
  const Mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(Lower)
  if (Mapped?.[1] !== undefined && isIP(Mapped[1]) === 4) return Mapped[1]
  return canonicalV6(Lower)
}

function ipInCidrs(Ip: string, Cidrs: Cidr[]): boolean {
  const Family = isIP(Ip)
  if (Family === 0) return false
  const Value = ipToBigInt(Ip)
  const Bits = Family === 4 ? 32 : 128
  return Cidrs.some((Cidr) => Cidr.family === Family && maskAddress(Value, Bits, Cidr.prefix) === Cidr.network)
}

/* IPv6 规范形（RFC 5952 简化：小写、去前导零、最长零串压缩） */
function canonicalV6(Ip: string): string {
  const Value = ipToBigInt(Ip)
  const Groups: string[] = []
  for (let Index = 7; Index >= 0; Index--) Groups.push(((Value >> BigInt(Index * 16)) & 0xffffn).toString(16))
  let BestStart = -1
  let BestLen = 0
  for (let Index = 0; Index < 8; ) {
    if (Groups[Index] !== '0') {
      Index++
      continue
    }
    let End = Index
    while (End < 8 && Groups[End] === '0') End++
    if (End - Index > BestLen && End - Index > 1) {
      BestStart = Index
      BestLen = End - Index
    }
    Index = End
  }
  if (BestStart === -1) return Groups.join(':')
  return `${Groups.slice(0, BestStart).join(':')}::${Groups.slice(BestStart + BestLen).join(':')}`
}

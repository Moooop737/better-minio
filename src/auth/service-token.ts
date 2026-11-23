/**
 * service token —— 服务间静态凭证（SERVICE_TOKENS = name:token 列表，config 启动时解析校验）。
 * 传输 `Authorization: Bearer <token>`；OCI /token 用 `Basic base64(name:token)`。
 * 比对 timingSafeEqual（长度不等直接 false），遍历全表不短路。
 */

export { createServiceTokenVerifier }
export type { ServiceTokenVerifier }

import { timingSafeEqual } from 'node:crypto'
import type { ServiceTokenEntry } from '../config'

interface ServiceTokenVerifier {
  /* 原始 token 值 → 服务名；不匹配 null */
  match(Token: string): string | null
  /* Authorization 头（Bearer）→ 服务名 */
  fromBearer(Header: string | undefined): string | null
  /* Authorization 头（Basic name:token）→ 服务名（name 必须与 token 对应条目一致） */
  fromBasic(Header: string | undefined): string | null
}

function createServiceTokenVerifier(Entries: ServiceTokenEntry[]): ServiceTokenVerifier {
  const Table = Entries.map((Entry) => ({ name: Entry.name, token: Buffer.from(Entry.token) }))

  function match(Token: string): string | null {
    const Candidate = Buffer.from(Token)
    let Hit: string | null = null
    for (const Entry of Table) {
      if (Entry.token.length === Candidate.length && timingSafeEqual(Entry.token, Candidate)) Hit = Entry.name
    }
    return Hit
  }

  return {
    match,
    fromBearer(Header) {
      const Token = parseScheme(Header, 'bearer')
      return Token === null ? null : match(Token)
    },
    fromBasic(Header) {
      const Encoded = parseScheme(Header, 'basic')
      if (Encoded === null) return null
      let Decoded: string
      try {
        Decoded = Buffer.from(Encoded, 'base64').toString('utf8')
      } catch {
        return null
      }
      const Index = Decoded.indexOf(':')
      if (Index <= 0) return null
      const Name = match(Decoded.slice(Index + 1))
      return Name !== null && Name === Decoded.slice(0, Index) ? Name : null
    },
  }
}

function parseScheme(Header: string | undefined, Scheme: string): string | null {
  if (Header === undefined) return null
  const Trimmed = Header.trim()
  const Space = Trimmed.indexOf(' ')
  if (Space === -1 || Trimmed.slice(0, Space).toLowerCase() !== Scheme) return null
  const Value = Trimmed.slice(Space + 1).trim()
  return Value === '' ? null : Value
}

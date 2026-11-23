import { describe, expect, it } from 'vitest'
import { normalizeEtag, reconcile } from '../../src/multipart/reconcile'

const PS = 5 * 1024 * 1024
const S = { partSize: PS }
const part = (N: number, Size = PS, Etag = `"e${N}"`) => ({ partNumber: N, etag: Etag, size: Size })
const claim = (N: number, Etag = `"e${N}"`) => ({ partNumber: N, etag: Etag })

describe('reconcile', () => {
  it('全齐全符 → ready，按编号升序', () => {
    const R = reconcile(S, [claim(3), claim(1), claim(2)], [part(1), part(2), part(3, 10)])
    expect(R).toEqual({ kind: 'ready', parts: [claim(1), claim(2), claim(3)] })
  })

  it('真源缺片 → missing', () => {
    const R = reconcile(S, [claim(1), claim(2), claim(3)], [part(1), part(3, 10)])
    expect(R).toEqual({ kind: 'incomplete', missing: [{ partNumber: 2, reason: 'missing' }] })
  })

  it('清单断档按 1..max 补齐期望集 → missing', () => {
    const R = reconcile(S, [claim(1), claim(3)], [part(1), part(2), part(3, 10)])
    expect(R).toEqual({ kind: 'incomplete', missing: [{ partNumber: 2, reason: 'missing' }] })
  })

  it('ETag 不符 → etag_mismatch（与缺片同列）', () => {
    const R = reconcile(S, [claim(1, '"zzz"'), claim(2)], [part(1), part(2, 10)])
    expect(R).toEqual({ kind: 'incomplete', missing: [{ partNumber: 1, reason: 'etag_mismatch' }] })
  })

  it('ETag 比较容忍引号与大小写', () => {
    expect(normalizeEtag('"ABC"')).toBe('abc')
    const R = reconcile(S, [claim(1, 'E1')], [part(1, 10, '"e1"')])
    expect(R.kind).toBe('ready')
  })

  it('非末片 ≠ partSize → size_mismatch 附编号（先于缺片判定）', () => {
    const R = reconcile(S, [claim(1), claim(2), claim(3), claim(4)], [part(1, 3 * 1024 * 1024), part(2), part(4, 10)])
    expect(R).toEqual({ kind: 'size_mismatch', partNumbers: [1] })
  })

  it('末片 > partSize → size_mismatch', () => {
    const R = reconcile(S, [claim(1), claim(2)], [part(1), part(2, PS + 1)])
    expect(R).toEqual({ kind: 'size_mismatch', partNumbers: [2] })
  })

  it('末片恰为 partSize 合法', () => {
    expect(reconcile(S, [claim(1), claim(2)], [part(1), part(2)]).kind).toBe('ready')
  })

  it('清单外（> max）的真源片忽略，不参与尺寸校验', () => {
    const R = reconcile(S, [claim(1)], [part(1, 10), part(2, 1)])
    expect(R).toEqual({ kind: 'ready', parts: [claim(1)] })
  })
})

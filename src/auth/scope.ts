/**
 * OCI scope —— `repository:<name>:<actions>` 解析、按服务裁剪授权、请求所需 ⊆ grants 判定。
 * name 走 distribution 正则；actions ⊆ {pull, push}；push 仅 OCI_PUSH_SERVICES 白名单服务可得。
 */

export { parseScope, grantScopes, hasScope, isRepositoryName, REPOSITORY_NAME_RE }
export type { ScopeRequest }

import { GatewayError } from '../core/errors'
import type { Grant } from './token'

const REPOSITORY_NAME_RE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/
const ACTIONS = new Set(['pull', 'push'])

interface ScopeRequest {
  name: string
  actions: string[]
}

function isRepositoryName(Name: string): boolean {
  return Name.length <= 255 && REPOSITORY_NAME_RE.test(Name)
}

function parseScope(Raw: string): ScopeRequest {
  const Parts = Raw.split(':')
  const [Type, Name, ActionsRaw] = Parts
  if (Parts.length !== 3 || Type !== 'repository' || Name === undefined || ActionsRaw === undefined || !isRepositoryName(Name)) {
    throw new GatewayError('E_VALIDATION', 'scope 格式非法')
  }
  const Actions = [...new Set(ActionsRaw.split(',').map((Action) => Action.trim()).filter((Action) => Action !== ''))]
  if (Actions.length === 0) throw new GatewayError('E_VALIDATION', 'scope 缺少 actions')
  for (const Action of Actions) {
    if (Action === '*') continue
    if (!ACTIONS.has(Action)) throw new GatewayError('E_VALIDATION', 'scope action 非法')
  }
  return { name: Name, actions: Actions }
}

/* 裁剪：push 只给白名单；'*' 展开为该服务被允许的全部 action；结果合并同名 repo */
function grantScopes(Service: string, Requested: ScopeRequest[], PushServices: string[]): Grant[] {
  const Allowed = PushServices.includes(Service) ? ['pull', 'push'] : ['pull']
  const Merged = new Map<string, Set<string>>()
  for (const Request of Requested) {
    const Wanted = Request.actions.includes('*') ? Allowed : Request.actions
    const Granted = Wanted.filter((Action) => Allowed.includes(Action))
    const Set_ = Merged.get(Request.name) ?? new Set<string>()
    for (const Action of Granted) Set_.add(Action)
    Merged.set(Request.name, Set_)
  }
  return [...Merged].filter(([, Actions]) => Actions.size > 0).map(([Name, Actions]) => ({ name: Name, actions: [...Actions].sort() }))
}

function hasScope(Grants: Grant[], Name: string, Action: 'pull' | 'push'): boolean {
  return Grants.some((Grant) => Grant.name === Name && Grant.actions.includes(Action))
}

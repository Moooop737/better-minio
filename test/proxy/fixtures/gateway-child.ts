/**
 * 子进程网关（100MB 内存验收用）—— 只跑 mountProxyData（放行闸桩），自采样 RSS 峰值；
 * 父进程通过 IPC 拿端口、结束时取 { growth }。单独进程才能把客户端 / 假上游的内存排除在测量之外。
 * 用法：fork(本文件, [upstreamUrl], { execArgv: ['--import', 'tsx', '--max-semi-space-size=1'] })。
 */

import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import type { AddressInfo } from 'node:net'
import { createEventBus } from '../../../src/core/events'
import type { AppEnv } from '../../../src/core/types'
import { mountProxyData } from '../../../src/proxy/routes'

const App = new Hono<AppEnv>()
mountProxyData(App, {
  internalEndpoint: process.argv[2] ?? '',
  bucket: 'kbfile',
  dataPlaneGate: async (c, next) => {
    c.set('identity', { kind: 'browser', sub: 's', resourceId: null, jti: 'j', op: 'put', key: 'big.bin', ip: '127.0.0.1' })
    await next()
  },
  corsOrigins: [],
  events: createEventBus(),
  rateLimit: null,
})
const Server = serve({ fetch: App.fetch, port: 0, hostname: '127.0.0.1' })
Server.once('listening', () => {
  const Base = process.memoryUsage().rss
  let Peak = Base
  setInterval(() => (Peak = Math.max(Peak, process.memoryUsage().rss)), 10).unref()
  process.on('message', () => process.send?.({ growth: Peak - Base }))
  process.send?.({ port: (Server.address() as AddressInfo).port })
})

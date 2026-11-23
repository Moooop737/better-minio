/**
 * 测试用 S3 后端 —— 起一个 moto server（python3 -m moto.server）作 MinIO 替身；不可用时 s3Available=false，集成用例 skip。
 * 用法：`const S3 = await startS3()`，`S3.endpoint` / `S3.client` / `await S3.stop()`。
 */

export { startS3, s3Available, TEST_ACCESS_KEY, TEST_SECRET_KEY }
export type { TestS3 }

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { createS3Client } from '../../src/api/client'
import type { S3Client } from '@aws-sdk/client-s3'

const TEST_ACCESS_KEY = 'testing'
const TEST_SECRET_KEY = 'testing-secret'

const s3Available: boolean = spawnSync('python3', ['-c', 'import moto.server'], { stdio: 'ignore' }).status === 0

interface TestS3 {
  endpoint: string
  client: S3Client
  stop(): Promise<void>
}

async function startS3(): Promise<TestS3> {
  const Port = await freePort()
  const Child = spawn('python3', ['-m', 'moto.server', '-H', '127.0.0.1', '-p', String(Port)], { stdio: 'ignore' })
  const Endpoint = `http://127.0.0.1:${Port}`
  for (let Attempt = 0; Attempt < 100; Attempt++) {
    try {
      const Res = await fetch(`${Endpoint}/moto-api/`)
      if (Res.status < 500) break
    } catch {
      await new Promise((Resolve) => setTimeout(Resolve, 100))
    }
  }
  const Client = createS3Client({ endpoint: Endpoint, region: 'us-east-1', forcePathStyle: true, accessKeyId: TEST_ACCESS_KEY, secretAccessKey: TEST_SECRET_KEY })
  return {
    endpoint: Endpoint,
    client: Client,
    async stop() {
      Client.destroy()
      Child.kill('SIGTERM')
    },
  }
}

async function freePort(): Promise<number> {
  return new Promise((Resolve, Reject) => {
    const Server = createServer()
    Server.listen(0, '127.0.0.1', () => {
      const Address = Server.address()
      Server.close(() => (typeof Address === 'object' && Address !== null ? Resolve(Address.port) : Reject(new Error('no port'))))
    })
  })
}

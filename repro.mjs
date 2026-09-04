// @fails-components/webtransport 1.6.7 keeps every bidirectional stream reachable
// after both sides closed it. Server and client in one process, N streams opened,
// used, and closed on both ends, then N more. Memory is read after a forced GC.
//
//   node --expose-gc repro.mjs [N]            (default N = 4000)
//   SNAPSHOT=1 node --expose-gc repro.mjs     also writes N.heapsnapshot, 2N.heapsnapshot
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeHeapSnapshot } from 'node:v8'
import { Http3Server, WebTransport } from '@fails-components/webtransport'

const N = Number(process.argv[2] ?? 4000)
const dir = mkdtempSync(join(tmpdir(), 'wt-'))
const key = join(dir, 'k.pem'), crt = join(dir, 'c.pem')
execFileSync('openssl', ['ecparam', '-name', 'prime256v1', '-genkey', '-noout', '-out', key])
execFileSync('openssl', ['req', '-new', '-x509', '-key', key, '-out', crt, '-days', '14',
  '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1'])
const cert = readFileSync(crt, 'utf8'), privKey = readFileSync(key, 'utf8')
const hash = createHash('sha256').update(new X509Certificate(cert).raw).digest()

const server = new Http3Server({ port: 0, host: '127.0.0.1', secret: 's', cert, privKey })
server.startServer()
await server.ready
const { port } = server.address()

// Server: for every incoming bidirectional stream, read to end, reply one byte, close.
;(async () => {
  const sessions = server.sessionStream('/').getReader()
  for (;;) {
    const { value: session, done } = await sessions.read()
    if (done) return
    await session.ready
    const streams = session.incomingBidirectionalStreams.getReader()
    for (;;) {
      const { value: s, done } = await streams.read()
      if (done) break
      ;(async () => {
        for (const r = s.readable.getReader(); !(await r.read()).done;);
        const w = s.writable.getWriter()
        await w.write(new Uint8Array([1]))
        await w.close()
      })().catch(() => {})
    }
  }
})()

const wt = new WebTransport(`https://127.0.0.1:${port}/`, {
  serverCertificateHashes: [{ algorithm: 'sha-256', value: hash }],
})
await wt.ready

// Client: open a stream, write one byte, close the writer, read the reply to end.
async function churn(count) {
  for (let i = 0; i < count; i++) {
    const s = await wt.createBidirectionalStream()
    const w = s.writable.getWriter()
    await w.write(new Uint8Array([1]))
    await w.close()
    for (const r = s.readable.getReader(); !(await r.read()).done;);
  }
}

async function measure(label) {
  for (let i = 0; i < 3; i++) { global.gc(); await new Promise((r) => setTimeout(r, 100)) }
  const m = process.memoryUsage()
  if (process.env.SNAPSHOT) writeHeapSnapshot(`${label}.heapsnapshot`)
  console.log(`${label.padEnd(4)} streams=${String(streamsSoFar).padStart(6)}  heapUsed=${mb(m.heapUsed)} MB  rss=${mb(m.rss)} MB  external=${mb(m.external)} MB`)
  return m
}
const mb = (b) => (b / 1048576).toFixed(1)
let streamsSoFar = 0

const base = await measure('0')
await churn(N); streamsSoFar = N
const one = await measure('N')
await churn(N); streamsSoFar = 2 * N
const two = await measure('2N')

const kb = (a, b) => ((b - a) / N / 1024).toFixed(2)
console.log(`\nper stream, N -> 2N:  heapUsed +${kb(one.heapUsed, two.heapUsed)} KB   rss +${kb(one.rss, two.rss)} KB`)
console.log(`per stream, 0 -> N:   heapUsed +${kb(base.heapUsed, one.heapUsed)} KB   rss +${kb(base.rss, one.rss)} KB`)
server.stopServer()
process.exit(0)

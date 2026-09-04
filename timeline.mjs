// Same churn as repro.mjs, sampled every STEP streams with a forced GC, written as
// CSV and SVG, with a least-squares line through the samples.
//   node --expose-gc timeline.mjs [TOTAL=16000] [STEP=250]
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Http3Server, WebTransport } from '@fails-components/webtransport'

const TOTAL = Number(process.argv[2] ?? 16000), STEP = Number(process.argv[3] ?? 250)
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

const rows = []
async function sample(n) {
  global.gc(); await new Promise((r) => setTimeout(r, 20)); global.gc()
  const m = process.memoryUsage()
  rows.push([n, m.heapUsed, m.rss, m.external, m.arrayBuffers, m.heapTotal])
}
await sample(0)
for (let i = 1; i <= TOTAL; i++) {
  const s = await wt.createBidirectionalStream()
  const w = s.writable.getWriter()
  await w.write(new Uint8Array([1]))
  await w.close()
  for (const r = s.readable.getReader(); !(await r.read()).done;);
  if (i % STEP === 0) await sample(i)
}
writeFileSync('timeline.csv', 'streams,heapUsed,rss,external,arrayBuffers,heapTotal\n' + rows.map((r) => r.join(',')).join('\n') + '\n')

function fit(col) {
  const xs = rows.map((r) => r[0]), ys = rows.map((r) => r[col])
  const n = xs.length, mx = xs.reduce((a, b) => a + b) / n, my = ys.reduce((a, b) => a + b) / n
  let sxx = 0, sxy = 0, syy = 0
  for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) ** 2; sxy += (xs[i] - mx) * (ys[i] - my); syy += (ys[i] - my) ** 2 }
  const slope = sxy / sxx, r2 = (sxy * sxy) / (sxx * syy)
  return { slope, intercept: my - slope * mx, r2 }
}
const fh = fit(1), fr = fit(2), ft = fit(5)
console.log(`${rows.length} samples, every ${STEP} streams up to ${TOTAL}`)
console.log(`heapUsed: ${(fh.slope / 1024).toFixed(2)} KB per stream, r^2 = ${fh.r2.toFixed(4)}`)
console.log(`rss:      ${(fr.slope / 1024).toFixed(2)} KB per stream, r^2 = ${fr.r2.toFixed(4)}`)
console.log(`heapTotal: ${(ft.slope / 1024).toFixed(2)} KB per stream, r^2 = ${ft.r2.toFixed(4)}`)

// SVG: heapUsed and rss against streams, with the fitted lines dashed.
const W = 900, H = 420, L = 70, R = 20, T = 30, B = 50
const maxY = Math.max(...rows.map((r) => r[2])) * 1.05
const x = (n) => L + (n / TOTAL) * (W - L - R), y = (v) => T + (1 - v / maxY) * (H - T - B)
const poly = (col, color) => `<polyline fill="none" stroke="${color}" stroke-width="2" points="${rows.map((r) => `${x(r[0]).toFixed(1)},${y(r[col]).toFixed(1)}`).join(' ')}"/>`
const line = (f, color) => `<line x1="${x(0)}" y1="${y(f.intercept)}" x2="${x(TOTAL)}" y2="${y(f.intercept + f.slope * TOTAL)}" stroke="${color}" stroke-dasharray="6 4" stroke-width="1"/>`
const ticks = []
for (let v = 0; v <= maxY; v += 50 * 1048576) ticks.push(`<line x1="${L}" y1="${y(v)}" x2="${W - R}" y2="${y(v)}" stroke="#ddd"/><text x="${L - 6}" y="${y(v) + 4}" text-anchor="end" font-size="11">${(v / 1048576).toFixed(0)} MB</text>`)
for (let n = 0; n <= TOTAL; n += TOTAL / 8) ticks.push(`<text x="${x(n)}" y="${H - B + 18}" text-anchor="middle" font-size="11">${n}</text>`)
writeFileSync('timeline.svg', `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" font-family="sans-serif" style="background:#fff">
<text x="${L}" y="18" font-size="13">@fails-components/webtransport 1.6.7, bidirectional stream churn, both halves in one process, GC before every sample</text>
${ticks.join('\n')}
${poly(2, '#c33')}${line(fr, '#c33')}
${poly(1, '#36c')}${line(fh, '#36c')}
<text x="${W - R}" y="${y(rows.at(-1)[2]) - 6}" text-anchor="end" font-size="12" fill="#c33">rss, ${(fr.slope / 1024).toFixed(1)} KB/stream</text>
<text x="${W - R}" y="${y(rows.at(-1)[1]) - 6}" text-anchor="end" font-size="12" fill="#36c">heapUsed, ${(fh.slope / 1024).toFixed(1)} KB/stream</text>
<text x="${(L + W - R) / 2}" y="${H - 8}" text-anchor="middle" font-size="12">streams opened and closed</text>
</svg>
`)
// The same chart on a near-black ground with light text, for dark colour schemes.
const light = readFileSync('timeline.svg', 'utf8')
const dark = light
  .replace('>', '>
<rect width="' + W + '" height="' + H + '" fill="#0d1117"/><style>text{fill:#e6edf3}</style>')
  .replaceAll('background:#fff', 'background:#0d1117')
  .replaceAll('stroke="#ddd"', 'stroke="#30363d"')
  .replaceAll('stroke="#c33"', 'stroke="#e66767"')
  .replaceAll('stroke="#36c"', 'stroke="#3987e5"')
  .replaceAll('fill="#c33"', 'fill="#e6edf3"')
  .replaceAll('fill="#36c"', 'fill="#e6edf3"')
writeFileSync('timeline-dark.svg', dark)
server.stopServer()
process.exit(0)

// Diff two V8 heap snapshots and print the retainer path of one grown object.
//   node --max-old-space-size=8192 heapdiff.mjs N.heapsnapshot 2N.heapsnapshot <N> [ClassName]
// No dependencies. Prints constructors whose instance count grew by about N,
// then the shortest non-weak path from one instance of ClassName to the GC root.
import { readFileSync } from 'node:fs'

const [a, b, nArg, wanted = 'HttpWTStream'] = process.argv.slice(2)
const N = Number(nArg)

function load(file) {
  const s = JSON.parse(readFileSync(file, 'utf8'))
  const nf = s.snapshot.meta.node_fields, ef = s.snapshot.meta.edge_fields
  const ntypes = s.snapshot.meta.node_types[0], etypes = s.snapshot.meta.edge_types[0]
  const I = (arr, k) => arr.indexOf(k)
  return {
    nodes: s.nodes, edges: s.edges, strings: s.strings, nf: nf.length, ef: ef.length,
    nType: I(nf, 'type'), nName: I(nf, 'name'), nId: I(nf, 'id'), nSize: I(nf, 'self_size'), nEdges: I(nf, 'edge_count'),
    eType: I(ef, 'type'), eName: I(ef, 'name_or_index'), eTo: I(ef, 'to_node'), ntypes, etypes,
    count: s.snapshot.node_count,
  }
}

function tally(h) {
  const m = new Map()
  for (let i = 0; i < h.count; i++) {
    const o = i * h.nf
    const key = h.ntypes[h.nodes[o + h.nType]] + ' ' + h.strings[h.nodes[o + h.nName]]
    const e = m.get(key) ?? { n: 0, bytes: 0 }
    e.n++; e.bytes += h.nodes[o + h.nSize]
    m.set(key, e)
  }
  return m
}

const A = load(a), B = load(b)
const ta = tally(A), tb = tally(B)
const rows = []
let totalA = 0, totalB = 0
for (const [k, v] of tb) { const p = ta.get(k) ?? { n: 0, bytes: 0 }; rows.push({ k, dn: v.n - p.n, db: v.bytes - p.bytes }); totalB += v.bytes }
for (const v of ta.values()) totalA += v.bytes
rows.sort((x, y) => y.dn - x.dn)
const near = (d) => Math.abs(d - N) <= N * 0.05 || Math.abs(d - 2 * N) <= N * 0.05
console.log(`node count ${A.count} -> ${B.count}   self_size total ${(totalA / 1048576).toFixed(1)} -> ${(totalB / 1048576).toFixed(1)} MB   = ${((totalB - totalA) / N / 1024).toFixed(2)} KB per stream over N=${N}`)
console.log('\ncount delta ~ N or 2N (type name: +count, +KB):')
for (const r of rows) if (near(r.dn)) console.log(`  ${String(r.dn).padStart(7)}  ${(r.db / 1024).toFixed(0).padStart(7)} KB  ${r.k}`)
console.log('\ntop 25 by count delta:')
for (const r of rows.slice(0, 25)) console.log(`  ${String(r.dn).padStart(7)}  ${(r.db / 1024).toFixed(0).padStart(7)} KB  ${r.k}`)
rows.sort((x, y) => y.db - x.db)
console.log('\ntop 15 by bytes delta:')
for (const r of rows.slice(0, 15)) console.log(`  ${String(r.dn).padStart(7)}  ${(r.db / 1024).toFixed(0).padStart(7)} KB  ${r.k}`)

// Retainer path in snapshot B for one instance of `wanted`.
const h = B
const firstEdge = new Uint32Array(h.count + 1)
for (let i = 0; i < h.count; i++) firstEdge[i + 1] = firstEdge[i] + h.nodes[i * h.nf + h.nEdges]
const rev = new Map() // to -> [[from, edgeIndex]]
for (let i = 0; i < h.count; i++) {
  for (let e = firstEdge[i]; e < firstEdge[i + 1]; e++) {
    const o = e * h.ef
    if (h.etypes[h.edges[o + h.eType]] === 'weak') continue
    const to = h.edges[o + h.eTo] / h.nf
    let l = rev.get(to); if (!l) rev.set(to, (l = []))
    l.push([i, e])
  }
}
const name = (i) => h.strings[h.nodes[i * h.nf + h.nName]]
const type = (i) => h.ntypes[h.nodes[i * h.nf + h.nType]]
const id = (i) => h.nodes[i * h.nf + h.nId]
const edgeLabel = (e) => {
  const o = e * h.ef, t = h.etypes[h.edges[o + h.eType]], v = h.edges[o + h.eName]
  return `${t}:${t === 'element' || t === 'hidden' ? '[' + v + ']' : h.strings[v]}`
}
let target = -1
for (let i = 0; i < h.count && target < 0; i++) if (type(i) === 'object' && name(i) === wanted) target = i
if (target < 0) { console.log(`\nno object named ${wanted}`); process.exit(0) }
console.log(`\ndirect retainers of ${wanted} @${id(target)} (${(rev.get(target) ?? []).length}):`)
for (const [from, e] of rev.get(target) ?? []) console.log(`  <- ${edgeLabel(e).padEnd(28)} ${type(from)} ${name(from)} @${id(from)}`)
// BFS from target backwards to node 0 (the synthetic root)
const prev = new Map([[target, null]]); const q = [target]
while (q.length) {
  const n = q.shift(); if (n === 0) break
  for (const [from, e] of rev.get(n) ?? []) if (!prev.has(from)) { prev.set(from, [n, e]); q.push(from) }
}
if (!prev.has(0)) { console.log('no non-weak path to root'); process.exit(0) }
console.log(`\nshortest non-weak path from GC root to ${wanted} @${id(target)}:`)
const path = []; for (let n = 0; n !== null; n = prev.get(n)?.[0] ?? null) { path.push(n); if (n === target) break }
for (let i = 0; i < path.length; i++) {
  const n = path[i]
  const via = i === 0 ? '' : `  --${edgeLabel(prev.get(path[i - 1])[1])}-->`
  console.log(`${via.padEnd(40)} ${type(n)} ${name(n)} @${id(n)}`)
}

// Audit in snapshot B: how full is each Set on each HttpWTSession, are all surviving
// HttpWTStream objects inside streamObjs, and does any native wrapper still hold a
// global handle of its own.
const fwd = (i) => { const out = []; for (let e = firstEdge[i]; e < firstEdge[i + 1]; e++) out.push([h.edges[e * h.ef + h.eTo] / h.nf, e]); return out }
const prop = (i, p) => { for (const [to, e] of fwd(i)) { const o = e * h.ef; if (h.etypes[h.edges[o + h.eType]] === 'property' && h.strings[h.edges[o + h.eName]] === p) return to } return -1 }
const setEntries = (set) => { const t = prop(set, 'table') >= 0 ? prop(set, 'table') : fwd(set).find(([to, e]) => h.etypes[h.edges[e * h.ef + h.eType]] === 'internal' && h.strings[h.edges[e * h.ef + h.eName]] === 'table')?.[0]; if (t === undefined || t < 0) return []; return fwd(t).map(([to]) => to).filter((to) => type(to) === 'object') }
const inStreamObjs = new Set()
console.log('\nsets on each HttpWTSession (entries):')
for (let i = 0; i < h.count; i++) {
  if (type(i) !== 'object' || name(i) !== 'HttpWTSession') continue
  const parts = []
  for (const p of ['streamObjs', 'sendStreams', 'receiveStreams', 'sendStreamsController', 'receiveStreamsController']) {
    const set = prop(i, p); const entries = set < 0 ? [] : setEntries(set)
    if (p === 'streamObjs') for (const e of entries) inStreamObjs.add(e)
    parts.push(`${p}=${entries.length}`)
  }
  console.log(`  HttpWTSession @${id(i)}  ${parts.join('  ')}`)
}
let total = 0, inSet = 0, wrappers = 0, wrappersGlobal = 0
let globalHandles = -1
for (let i = 0; i < h.count; i++) if (type(i) === 'synthetic' && name(i) === '(Global handles)') globalHandles = i
const fromGlobal = new Set(globalHandles < 0 ? [] : fwd(globalHandles).map(([to]) => to))
for (let i = 0; i < h.count; i++) {
  if (type(i) !== 'object') continue
  if (name(i) === wanted) { total++; if (inStreamObjs.has(i)) inSet++ }
  if (name(i) === 'Http3WTStreamVisitor') { wrappers++; if (fromGlobal.has(i)) wrappersGlobal++ }
}
console.log(`\n${wanted}: ${total} objects, ${inSet} of them entries of a streamObjs Set`)
console.log(`Http3WTStreamVisitor: ${wrappers} objects, ${wrappersGlobal} of them held by (Global handles)`)

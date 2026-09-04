// One chart, two runs of timeline.mjs: heapUsed against streams, unpatched and patched.
//   node chart.mjs timeline.csv timeline-patched.csv     writes heap.svg and heap.html
import { readFileSync, writeFileSync } from 'node:fs'

const [unpatchedCsv, patchedCsv] = process.argv.slice(2)
const load = (f) => readFileSync(f, 'utf8').trim().split('\n').slice(1).map((l) => l.split(',').map(Number)).map(([streams, heapUsed]) => ({ x: streams, y: heapUsed }))
const series = [
  { name: '1.6.7 as published', rows: load(unpatchedCsv), key: 's1', hex: '#2a78d6' },
  { name: '1.6.7 with the patch', rows: load(patchedCsv), key: 's2', hex: '#eb6834' },
]
const fit = (rows) => {
  const n = rows.length, mx = rows.reduce((a, r) => a + r.x, 0) / n, my = rows.reduce((a, r) => a + r.y, 0) / n
  let sxx = 0, sxy = 0
  for (const r of rows) { sxx += (r.x - mx) ** 2; sxy += (r.x - mx) * (r.y - my) }
  return sxy / sxx
}
for (const s of series) s.slope = fit(s.rows)

const W = 1100, H = 520, L = 64, R = 210, T = 84, B = 56
const maxX = Math.max(...series.flatMap((s) => s.rows.map((r) => r.x)))
const maxY = Math.max(...series.flatMap((s) => s.rows.map((r) => r.y))) * 1.06
const x = (v) => L + (v / maxX) * (W - L - R), y = (v) => T + (1 - v / maxY) * (H - T - B)
const MB = 1048576
const yStep = maxY > 100 * MB ? 50 * MB : 10 * MB
let grid = ''
for (let v = 0; v <= maxY; v += yStep) grid += `<line x1="${L}" y1="${y(v).toFixed(1)}" x2="${W - R}" y2="${y(v).toFixed(1)}" class="grid"/><text x="${L - 8}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end" class="tick">${v / MB} MB</text>\n`
for (let v = 0; v <= maxX; v += maxX / 8) grid += `<text x="${x(v).toFixed(1)}" y="${H - B + 20}" text-anchor="middle" class="tick">${v.toLocaleString('en-US')}</text>\n`
const lines = (c) => series.map((s, i) => `<polyline class="line" stroke="${c[s.key]}" points="${s.rows.map((r) => `${x(r.x).toFixed(1)},${y(r.y).toFixed(1)}`).join(' ')}"/>`).join('\n')
const labels = (c) => series.map((s) => { const last = s.rows.at(-1); return `<circle cx="${x(last.x).toFixed(1)}" cy="${y(last.y).toFixed(1)}" r="4" fill="${c[s.key]}" class="end"/><text x="${(x(last.x) + 10).toFixed(1)}" y="${(y(last.y) + 4).toFixed(1)}" class="label">${(s.slope / 1024).toFixed(2)} KB per stream</text>` }).join('\n')
const legend = (c) => series.map((s, i) => `<g transform="translate(${L + i * 210},${T - 30})"><line x1="0" y1="0" x2="22" y2="0" stroke="${c[s.key]}" stroke-width="2"/><text x="28" y="4" class="label">${s.name}</text></g>`).join('')

const LIGHT = { surface: '#fcfcfb', ink: '#0b0b0b', ink2: '#52514e', grid: '#e6e5e1', s1: '#2a78d6', s2: '#eb6834' }
const VARS = { surface: 'var(--surface)', ink: 'var(--ink)', ink2: 'var(--ink2)', grid: 'var(--gridc)', s1: 'var(--s1)', s2: 'var(--s2)' }
const svg = (extra = '', c = VARS) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" class="viz" role="img" aria-label="Heap used against closed bidirectional streams, unpatched and patched">
<style>
.viz{--surface:#fcfcfb;--ink:#0b0b0b;--ink2:#52514e;--gridc:#e6e5e1;--s1:#2a78d6;--s2:#eb6834;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
@media (prefers-color-scheme:dark){:root:where(:not([data-theme="light"])) .viz{--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--gridc:#2e2e2c;--s1:#3987e5;--s2:#d95926}}
:root[data-theme="dark"] .viz{--surface:#1a1a19;--ink:#fff;--ink2:#c3c2b7;--gridc:#2e2e2c;--s1:#3987e5;--s2:#d95926}
.viz .title{font-size:14px;fill:${c.ink}}.viz .tick{font-size:11px;fill:${c.ink2}}.viz .label{font-size:12px;fill:${c.ink}}.viz .axis{font-size:12px;fill:${c.ink2}}
.viz .grid{stroke:${c.grid};stroke-width:1}.viz .line{fill:none;stroke-width:2;stroke-linejoin:round}.viz .end{stroke:${c.surface};stroke-width:2}
</style>
<rect width="${W}" height="${H}" fill="${c.surface}"/>
<text x="${L}" y="26" class="title">JS heap after a forced GC, both halves of every stream in one process, ${maxX.toLocaleString('en-US')} streams opened and closed</text>
${legend(c)}
${grid}
${lines(c)}
${labels(c)}
<text x="${((L + W - R) / 2).toFixed(0)}" y="${H - 12}" text-anchor="middle" class="axis">bidirectional streams opened, used and closed on both ends</text>
<text transform="translate(14,${((T + H - B) / 2).toFixed(0)}) rotate(-90)" text-anchor="middle" class="axis">heapUsed</text>
${extra}
</svg>`

writeFileSync('heap.svg', svg('', LIGHT))

const data = JSON.stringify(series.map((s) => ({ name: s.name, hex: s.hex, rows: s.rows })))
const table = `<details><summary>Table view</summary><table><thead><tr><th>streams</th>${series.map((s) => `<th>${s.name}, heapUsed MB</th>`).join('')}</tr></thead><tbody>${series[0].rows.map((r, i) => `<tr><td>${r.x}</td>${series.map((s) => `<td>${(s.rows[i]?.y / MB).toFixed(1)}</td>`).join('')}</tr>`).join('')}</tbody></table></details>`
writeFileSync('heap.html', `<!doctype html>
<meta charset="utf-8"><title>Heap per closed stream, unpatched and patched</title>
<style>body{margin:0;padding:24px;background:#fcfcfb;color:#0b0b0b;font-family:system-ui,sans-serif}@media (prefers-color-scheme:dark){body{background:#1a1a19;color:#fff}}
.wrap{position:relative;max-width:${W}px}svg{width:100%;height:auto;display:block}
.tip{position:absolute;pointer-events:none;background:#fff;color:#0b0b0b;border:1px solid #d6d5d0;border-radius:6px;padding:6px 8px;font-size:12px;box-shadow:0 2px 8px rgba(0,0,0,.12);display:none;white-space:nowrap}
@media (prefers-color-scheme:dark){.tip{background:#262624;color:#fff;border-color:#3a3a38}}
table{border-collapse:collapse;font-size:12px;margin-top:8px}td,th{padding:2px 10px;text-align:right;border-bottom:1px solid #e6e5e1}details{margin-top:16px}
p{max-width:${W}px;font-size:14px;line-height:1.5}</style>
<div class="wrap">${svg(`<line id="xh" class="grid" y1="${T}" y2="${H - B}" style="display:none;stroke:#52514e"/>${series.map((s, i) => `<circle id="d${i}" r="5" fill="var(--${s.key})" class="end" style="display:none"/>`).join('')}<rect id="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/>`)}<div class="tip" id="tip"></div></div>
<p>Same script, same N, same machine. The only difference between the two runs is <code>removeStreamObjIfFinished()</code> in <code>lib/stream.js</code>. Slopes are least-squares fits over all 65 samples.</p>
${table}
<script>
const S=${data},W=${W},L=${L},R=${R},T=${T},B=${B},maxX=${maxX},maxY=${maxY};
const svg=document.querySelector('svg'),hit=document.getElementById('hit'),tip=document.getElementById('tip'),xh=document.getElementById('xh');
const X=v=>L+v/maxX*(W-L-R),Y=v=>T+(1-v/maxY)*(H-T-B);const H=${H};
hit.addEventListener('mousemove',e=>{const pt=svg.createSVGPoint();pt.x=e.clientX;pt.y=e.clientY;const p=pt.matrixTransform(svg.getScreenCTM().inverse());
const xv=(p.x-L)/(W-L-R)*maxX;let best=0,bd=1e18;S[0].rows.forEach((r,i)=>{const d=Math.abs(r.x-xv);if(d<bd){bd=d;best=i}});const r0=S[0].rows[best];
xh.setAttribute('x1',X(r0.x));xh.setAttribute('x2',X(r0.x));xh.style.display='';
let html='<b>'+r0.x.toLocaleString('en-US')+' streams</b>';S.forEach((s,i)=>{const r=s.rows[best];if(!r)return;const d=document.getElementById('d'+i);d.setAttribute('cx',X(r.x));d.setAttribute('cy',Y(r.y));d.style.display='';html+='<br><span style="color:'+s.hex+'">&#9632;</span> '+s.name+': '+(r.y/1048576).toFixed(1)+' MB'});
tip.innerHTML=html;tip.style.display='block';const box=svg.getBoundingClientRect();tip.style.left=(e.clientX-box.left+14)+'px';tip.style.top=(e.clientY-box.top-10)+'px'});
hit.addEventListener('mouseleave',()=>{tip.style.display='none';xh.style.display='none';S.forEach((s,i)=>document.getElementById('d'+i).style.display='none')});
</script>
`)
console.log(series.map((s) => `${s.name}: ${(s.slope / 1024).toFixed(3)} KB per stream`).join('\n'))

'use strict'

const $ = (id) => document.getElementById(id)
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

const input = $('rawInput')
const output = $('sanitizedOutput')
const inputStatus = $('inputStatus')
const outputStatus = $('outputStatus')
const fileInput = $('fileInput')
const fileRedactButton = $('fileRedactButton')

const MAX_FILE_BYTES = 5 * 1024 * 1024
const MAX_INLINE_BYTES = 1000000 // above this, a file is redacted on the server only
const FILE_PATTERN = /\.(txt|csv|tsv|log|json|md)$/i

let currentFile = null
let lastTokens = []
let counts = { total: 0, safe: 0, redacted: 0, rejected: 0 }
let filter = 'all'
let selectedIndex = -1
let dfas = []
let activeDfa = null
let scanRun = 0
let scanned = false

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  )
}

function setStatus(element, message, isError = false) {
  element.textContent = message
  element.classList.toggle('error', isError)
}

async function api(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`)
  return data
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = name
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000) // revoking at once breaks the download in some browsers
}

// ---------------------------------------------------------------- theme
$('themeToggle').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'
  document.documentElement.dataset.theme = next
  try {
    localStorage.setItem('theme', next)
  } catch (e) {
    /* storage can be blocked; the choice then lasts for this visit only */
  }
})

// ---------------------------------------------------------------- hero tape
function renderTape(container, chars, step, deadAt = -1) {
  container.innerHTML = chars
    .map((ch, i) => {
      const cls = i === deadAt ? 'bad' : i < step ? 'done' : i === step ? 'now' : ''
      return `<span class="cell ${cls}">${escapeHtml(ch === ' ' ? '\u2423' : ch)}</span>`
    })
    .join('')
}

async function startHeroTape() {
  const tape = $('heroTape')
  const stateEl = $('heroState')
  const outEl = $('heroOut')
  let trace
  try {
    trace = await api('/trace', { token: 'john.doe@email.com', dfa: 'email' })
  } catch (e) {
    return // decorative only
  }
  const chars = trace.steps.map((s) => s.char)
  const show = (k) => {
    renderTape(tape, chars, k)
    stateEl.textContent = k === 0 ? 'q0' : trace.steps[k - 1].new_state
    stateEl.className = 'state-pill' + (k === chars.length ? ' ok' : '')
    outEl.textContent = k === chars.length ? '\u2192 [EMAIL_01]' : ''
  }
  if (reducedMotion) return show(chars.length)
  let k = 0
  const tick = () => {
    show(k)
    const last = k === chars.length
    k = last ? 0 : k + 1
    setTimeout(tick, last ? 2400 : 170)
  }
  tick()
}

// ---------------------------------------------------------------- playground
// Nothing runs until the user clicks Redact.
input.addEventListener('input', () => {
  if (output.value) setStatus(inputStatus, 'Input changed. Click Redact to update the output.')
})
$('redactButton').addEventListener('click', runEngine)

async function runEngine() {
  const run = ++scanRun
  setStatus(inputStatus, '')
  setStatus(outputStatus, '')
  try {
    const data = await api('/scan', { text: input.value })
    if (run !== scanRun) return // a newer scan is already on its way
    output.value = data.redacted_text
    counts = {
      total: data.total_tokens,
      safe: data.text_count,
      redacted: data.pii_count,
      rejected: data.rejected_count,
    }
    $('statSafe').textContent = counts.safe
    $('statRedacted').textContent = counts.redacted
    $('statRejected').textContent = counts.rejected
    lastTokens = data.tokens
    selectedIndex = -1
    drawCards()
    scanned = true
    renderSimResults()
    // show the first redacted token in the DFA simulator right away
    const firstHit = lastTokens.findIndex((t) => t.dfa_id && t.accepted)
    const firstDfa = firstHit >= 0 ? firstHit : lastTokens.findIndex((t) => t.dfa_id)
    if (firstDfa >= 0) selectToken(firstDfa)
  } catch (error) {
    if (run === scanRun) setStatus(inputStatus, `Could not redact text: ${error.message}`, true)
  }
}

// files
$('chooseFile').addEventListener('click', () => fileInput.click())
fileInput.addEventListener('change', () => {
  if (fileInput.files.length) loadFile(fileInput.files[0])
})
const dropZone = $('dropZone')
for (const name of ['dragenter', 'dragover']) {
  dropZone.addEventListener(name, (e) => {
    e.preventDefault()
    dropZone.classList.add('over')
  })
}
for (const name of ['dragleave', 'drop']) {
  dropZone.addEventListener(name, (e) => {
    e.preventDefault()
    dropZone.classList.remove('over')
  })
}
dropZone.addEventListener('drop', (e) => {
  if (e.dataTransfer.files.length) loadFile(e.dataTransfer.files[0])
})
// A file dropped outside the zone would otherwise make the browser open it and leave the page.
for (const name of ['dragover', 'drop']) window.addEventListener(name, (e) => e.preventDefault())

async function loadFile(file) {
  fileInput.value = ''
  if (!FILE_PATTERN.test(file.name)) {
    return setStatus(inputStatus, 'Choose a .txt, .csv, .tsv, .log, .json or .md file.', true)
  }
  if (file.size > MAX_FILE_BYTES) {
    return setStatus(inputStatus, `${file.name} is larger than 5 MB.`, true)
  }
  currentFile = file
  fileRedactButton.disabled = false
  if (file.size > MAX_INLINE_BYTES) {
    input.value = ''
    return setStatus(inputStatus, `${file.name} is too large to preview. Use "Redact file and download".`)
  }
  try {
    input.value = await file.text()
    setStatus(inputStatus, `${file.name} loaded. Click Redact to run it.`)
  } catch (error) {
    setStatus(inputStatus, `Could not read file: ${error.message}`, true)
  }
}

fileRedactButton.addEventListener('click', async () => {
  if (!currentFile) return
  fileRedactButton.disabled = true
  try {
    const response = await fetch('/redact-file?name=' + encodeURIComponent(currentFile.name), {
      method: 'POST',
      body: await currentFile.arrayBuffer(),
    })
    if (!response.ok) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.error || `Request failed (${response.status}).`)
    }
    const dot = currentFile.name.lastIndexOf('.')
    const name = currentFile.name.slice(0, dot) + '.redacted' + currentFile.name.slice(dot)
    saveBlob(await response.blob(), name)
    setStatus(inputStatus, `${name} downloaded (${response.headers.get('X-PII-Count')} items redacted).`)
  } catch (error) {
    setStatus(inputStatus, `Could not redact file: ${error.message}`, true)
  } finally {
    fileRedactButton.disabled = false
  }
})

$('copyButton').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(output.value)
    setStatus(outputStatus, 'Output copied.')
  } catch (error) {
    setStatus(outputStatus, `Could not copy output: ${error.message}`, true)
  }
})
$('downloadButton').addEventListener('click', () => {
  saveBlob(new Blob([output.value], { type: 'text/plain;charset=utf-8' }), 'redacted-output.txt')
  setStatus(outputStatus, 'Download started.')
})

// ---------------------------------------------------------------- results
const MAX_CARDS = 120
const kindOf = (t) => (t.type === 'TEXT' ? 'safe' : t.accepted ? 'redacted' : 'rejected')
const FILTERS = [
  ['all', 'All', () => counts.total],
  ['redacted', 'Redacted', () => counts.redacted],
  ['rejected', 'Rejected', () => counts.rejected],
  ['safe', 'Safe', () => counts.safe],
]

function drawCards() {
  $('filters').innerHTML = FILTERS.map(
    ([key, label, count]) =>
      `<button class="chip" type="button" data-f="${key}" aria-pressed="${key === filter}">${label} (${count()})</button>`,
  ).join('')
  $('filters').querySelectorAll('.chip').forEach((btn) =>
    btn.addEventListener('click', () => {
      filter = btn.dataset.f
      drawCards()
    }),
  )

  const grid = $('resultsGrid')
  const visible = lastTokens
    .map((token, index) => ({ token, index }))
    .filter(({ token }) => filter === 'all' || kindOf(token) === filter)
  if (!visible.length) {
    grid.innerHTML = '<p class="empty">Nothing to show here.</p>'
    return
  }
  const label = { safe: 'Safe', redacted: 'Redacted', rejected: 'Rejected' }
  const html = visible.slice(0, MAX_CARDS).map(({ token, index }) => {
    const kind = kindOf(token)
    return `<article class="card" data-index="${index}" tabindex="0" aria-current="${index === selectedIndex}">
      <div class="card-top"><span class="type">${escapeHtml(token.type)}</span><span class="badge ${kind === 'redacted' ? '' : kind}">${label[kind]}</span></div>
      <div class="tok">${escapeHtml(token.token)}</div>
      ${token.accepted ? `<div class="tok-out">&rarr; ${escapeHtml(token.redacted_tag)}</div>` : ''}
      ${token.dfa_id ? `<div class="dfa-line">${escapeHtml(dfaName(token.dfa_id))} ended in ${escapeHtml(token.final_state)}</div>` : ''}
      ${kind === 'rejected' ? `<p class="reason">${escapeHtml(token.reason)}</p>` : ''}
    </article>`
  })
  const hidden = (filter === 'all' ? counts.total : FILTERS.find((f) => f[0] === filter)[2]()) - Math.min(visible.length, MAX_CARDS)
  if (hidden > 0) html.push(`<p class="empty">and ${hidden} more. The counts above include every token.</p>`)
  grid.innerHTML = html.join('')
  grid.querySelectorAll('.card').forEach((card) => {
    const pick = () => selectToken(Number(card.dataset.index))
    card.addEventListener('click', pick)
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        pick()
      }
    })
  })
}

function dfaName(id) {
  const d = dfas.find((x) => x.id === id)
  if (!d) return id
  const extra = d.id === 'api_generic' ? ' (no prefix)' : d.id === 'api_vendor' ? ' (vendor prefix)' : ''
  return `${d.name} DFA${extra}`
}

function selectToken(index) {
  selectedIndex = index
  document
    .querySelectorAll('#resultsGrid .card')
    .forEach((c) => c.setAttribute('aria-current', String(Number(c.dataset.index) === index)))
  const token = lastTokens[index]
  const hint = $('resultsHint')
  if (!token.dfa_id) {
    hint.textContent = 'Plain text: no DFA matched this token.'
    return
  }
  hint.innerHTML = 'Path loaded in the <a href="#lab">DFA simulator</a>.'
  activeDfa = token.dfa_id
  $('simInput').value = token.token
  renderTabs()
  renderSimResults()
  runSimulation(token.token, false)
}

// ---------------------------------------------------------------- playground result inside the simulator
const MAX_SIM_TOKENS = 40

function renderSimResults() {
  $('simResultsEmpty').hidden = scanned
  $('simResultsBody').hidden = !scanned
  if (!scanned) return
  $('simResultText').textContent = output.value
  const items = lastTokens.map((token, index) => ({ token, index })).filter(({ token }) => token.dfa_id)
  const list = $('simResultList')
  if (!items.length) {
    list.innerHTML = '<p class="hint">No token reached a DFA, so nothing was redacted.</p>'
    return
  }
  list.innerHTML = items
    .slice(0, MAX_SIM_TOKENS)
    .map(({ token, index }) => {
      const result = token.accepted
        ? `${escapeHtml(dfaName(token.dfa_id))} accepted in q1 &rarr; ${escapeHtml(token.redacted_tag)}`
        : `${escapeHtml(dfaName(token.dfa_id))} rejected in q_d`
      return `<button class="tok-btn" type="button" data-index="${index}" aria-pressed="${index === selectedIndex}">
        <span class="tok">${escapeHtml(token.token)}</span><small class="${token.accepted ? '' : 'bad'}">${result}</small></button>`
    })
    .join('')
  if (items.length > MAX_SIM_TOKENS) {
    list.insertAdjacentHTML('beforeend', `<p class="hint">and ${items.length - MAX_SIM_TOKENS} more in the results above.</p>`)
  }
  list.querySelectorAll('.tok-btn').forEach((btn) =>
    btn.addEventListener('click', () => selectToken(Number(btn.dataset.index))),
  )
}

// ---------------------------------------------------------------- DFA simulator
async function loadAutomata() {
  try {
    dfas = await (await fetch('/api/dfas')).json()
    activeDfa = dfas[0].id
    renderTabs()
    await runSimulation($('simInput').value, false)
  } catch (error) {
    $('dfaDesc').textContent = 'Could not load automata: ' + error.message
  }
}

function tabLabel(d) {
  return d.name + (d.id === 'api_generic' ? ' (no prefix)' : d.id === 'api_vendor' ? ' (vendor prefix)' : '')
}

function renderTabs() {
  const tabs = $('dfaTabs')
  tabs.innerHTML = dfas
    .map(
      (d) =>
        `<button class="chip" type="button" role="tab" data-id="${escapeHtml(d.id)}" aria-selected="${d.id === activeDfa}">${escapeHtml(tabLabel(d))}</button>`,
    )
    .join('')
  tabs.querySelectorAll('.chip').forEach((btn) =>
    btn.addEventListener('click', () => {
      activeDfa = btn.dataset.id
      renderTabs()
      runSimulation($('simInput').value, false)
    }),
  )
  const dfa = dfas.find((d) => d.id === activeDfa)
  $('dfaDesc').textContent = dfa.description
  $('dfaLegend').textContent = ''
  const accepting = dfa.nodes.filter((n) => n.accepting).map((n) => n.id)
  const rows = [
    ['Q', `<b>${dfa.nodes.length}</b> drawn states (similar states are grouped): ${dfa.nodes.map((n) => escapeHtml(n.id)).join(', ')}`],
    ['\u03a3', escapeHtml(dfa.legend)],
    ['\u03b4', 'transition table: the arrows below. A missing arrow goes to the dead state q_d'],
    ['q0', escapeHtml(dfa.nodes[0].id)],
    ['F', `${accepting.map(escapeHtml).join(', ')}. Reaching it reports q1`],
  ]
  $('dfaDef').innerHTML = rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')
}

// simulator state: `trace` is the server's answer, `step` how many characters have been read
const sim = { trace: null, step: 0, timer: null }

async function runSimulation(token, autoplay) {
  stopPlaying()
  if (!token) {
    sim.trace = null
    return renderSim()
  }
  try {
    sim.trace = await api('/trace', { token, dfa: activeDfa })
    sim.step = autoplay && !reducedMotion ? 0 : sim.trace.steps.length
    renderSim()
    if (autoplay && !reducedMotion) startPlaying()
  } catch (error) {
    sim.trace = null
    renderSim()
    $('simVerdict').textContent = error.message
    $('simVerdict').className = 'verdict bad'
  }
}

function startPlaying() {
  if (!sim.trace || sim.step >= sim.trace.steps.length) sim.step = 0
  $('simPlay').textContent = 'Pause'
  sim.timer = setInterval(() => {
    if (sim.step >= sim.trace.steps.length) return stopPlaying()
    sim.step++
    renderSim()
  }, 450)
  renderSim()
}

function stopPlaying() {
  clearInterval(sim.timer)
  sim.timer = null
  $('simPlay').textContent = 'Play'
}

$('simForm').addEventListener('submit', (e) => {
  e.preventDefault()
  runSimulation($('simInput').value, true)
})
$('simPlay').addEventListener('click', () => (sim.timer ? stopPlaying() : sim.trace && startPlaying()))
$('simStep').addEventListener('click', () => {
  stopPlaying()
  if (sim.trace && sim.step < sim.trace.steps.length) sim.step++
  renderSim()
})
$('simBack').addEventListener('click', () => {
  stopPlaying()
  if (sim.step > 0) sim.step--
  renderSim()
})
$('simReset').addEventListener('click', () => {
  stopPlaying()
  sim.step = 0
  renderSim()
})

function renderSim() {
  const dfa = dfas.find((d) => d.id === activeDfa)
  if (!dfa) return
  const trace = sim.trace
  const verdict = $('simVerdict')
  const state = $('simState')

  if (!trace) {
    $('diagramWrap').innerHTML = drawDiagram(dfa, [dfa.nodes[0].id])
    $('simTape').innerHTML = ''
    $('traceWrap').innerHTML = ''
    state.textContent = 'start'
    state.className = 'state-pill'
    verdict.textContent = 'Enter a string and press Run.'
    verdict.className = 'verdict'
    return
  }

  const k = sim.step
  const n = trace.steps.length
  const path = trace.path.slice(0, k + 1)
  const deadAt = trace.steps.findIndex((s) => s.new_state === 'q_d')
  $('diagramWrap').innerHTML = drawDiagram(dfa, path)
  renderTape($('simTape'), trace.steps.map((s) => s.char), k, deadAt >= 0 && k > deadAt ? deadAt : -1)

  const current = k === 0 ? 'start' : trace.steps[k - 1].new_state
  state.textContent = current
  state.className = 'state-pill' + (current === 'q_d' ? ' bad' : k === n && trace.accepted ? ' ok' : '')

  if (k < n && current !== 'q_d') {
    verdict.textContent = `Read ${k} of ${n} characters.`
    verdict.className = 'verdict'
  } else if (current === 'q_d') {
    verdict.textContent = `Rejected in the dead state q_d: ${trace.reason}.`
    verdict.className = 'verdict bad'
  } else if (trace.accepted) {
    verdict.textContent = `Accepted in state q1: ${trace.reason}.`
    verdict.className = 'verdict ok'
  } else {
    verdict.textContent = `Rejected: ${trace.reason}.`
    verdict.className = 'verdict bad'
  }

  const rows = trace.steps
    .slice(0, k)
    .map(
      (s, i) => `<tr class="${i === k - 1 ? 'latest' : ''}"><td>${s.step}</td><td>${escapeHtml(s.char)}</td><td>${escapeHtml(s.char_class)}</td>
        <td>${escapeHtml(s.old_state)}</td><td class="${s.new_state === 'q_d' ? 'dead' : ''}">${escapeHtml(s.new_state)}</td></tr>`,
    )
    .join('')
  $('traceWrap').innerHTML = k
    ? `<table class="trace"><thead><tr><th>#</th><th>Char</th><th>Symbol</th><th>From</th><th>To</th></tr></thead><tbody>${rows}</tbody></table>`
    : ''
}

// ---------------------------------------------------------------- diagram
function splitLabel(text) {
  const mid = text.lastIndexOf(' ', Math.ceil(text.length / 2) + 3)
  return mid > 0 ? [text.slice(0, mid), text.slice(mid + 1)] : [text]
}

function drawDiagram(dfa, path) {
  const W = 126, H = 52, GAP = 76, X0 = 28, Y = 150
  const pos = {}
  dfa.nodes.forEach((n, i) => (pos[n.id] = i))
  const cx = (id) => X0 + pos[id] * (W + GAP) + W / 2
  const width = X0 * 2 + dfa.nodes.length * W + (dfa.nodes.length - 1) * GAP
  const visitedNodes = new Set(path)
  const currentNode = path[path.length - 1]
  const visitedEdges = new Set()
  for (let i = 0; i + 1 < path.length; i++) visitedEdges.add(path[i] + '>' + path[i + 1])

  let svg = `<svg width="${width}" height="${Y * 2 + 40}" viewBox="0 0 ${width} ${Y * 2 + 40}" role="img" aria-label="${escapeHtml(dfa.name)} automaton">
    <defs>
      <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="head" d="M0 0 L10 5 L0 10 z"/></marker>
      <marker id="arrowOn" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="head visited" d="M0 0 L10 5 L0 10 z"/></marker>
    </defs>`

  const edges = [...dfa.edges].sort(
    (a, b) => Math.abs(pos[a.to] - pos[a.from]) - Math.abs(pos[b.to] - pos[b.from]),
  )
  for (const e of edges) {
    const on = visitedEdges.has(e.from + '>' + e.to)
    const a = pos[e.from], b = pos[e.to], x1 = cx(e.from), x2 = cx(e.to)
    let d, lx, ly
    if (a === b) {
      d = `M ${x1 - 18} ${Y - H / 2} C ${x1 - 34} ${Y - 78}, ${x1 + 34} ${Y - 78}, ${x1 + 18} ${Y - H / 2}`
      lx = x1
      ly = Y - 70
    } else if (b === a + 1) {
      d = `M ${x1 + W / 2} ${Y} L ${x2 - W / 2} ${Y}`
      lx = (x1 + x2) / 2
      ly = Y - 7
    } else if (b > a) {
      const h = 40 + 22 * (b - a)
      d = `M ${x1 + 14} ${Y - H / 2} Q ${(x1 + x2) / 2} ${Y - H / 2 - h * 1.6}, ${x2 - 14} ${Y - H / 2}`
      lx = (x1 + x2) / 2
      ly = Y - H / 2 - h * 0.8 - 4
    } else {
      const h = 40 + 22 * (a - b)
      d = `M ${x1 - 14} ${Y + H / 2} Q ${(x1 + x2) / 2} ${Y + H / 2 + h * 1.6}, ${x2 + 14} ${Y + H / 2}`
      lx = (x1 + x2) / 2
      ly = Y + H / 2 + h * 0.8 + 12
    }
    svg += `<path class="edge${on ? ' visited' : ''}" d="${d}" marker-end="url(#${on ? 'arrowOn' : 'arrow'})"/><text class="edge-label" x="${lx}" y="${ly}">${escapeHtml(e.label)}</text>`
  }
  svg += `<path class="edge" d="M ${X0 - 22} ${Y} L ${X0} ${Y}" marker-end="url(#arrow)"/>`

  for (const n of dfa.nodes) {
    const x = cx(n.id) - W / 2
    const cls = 'node' + (n.accepting ? ' accepting' : '') + (visitedNodes.has(n.id) ? ' visited' : '') + (n.id === currentNode ? ' current' : '')
    const words = n.id.length > 15 ? splitLabel(n.id) : [n.id]
    svg += `<rect class="${cls}" x="${x}" y="${Y - H / 2}" width="${W}" height="${H}" rx="${n.accepting ? 8 : 6}"/>`
    if (n.accepting) {
      svg += `<rect class="${cls}" x="${x + 4}" y="${Y - H / 2 + 4}" width="${W - 8}" height="${H - 8}" rx="5"/>`
    }
    words.forEach((w, i) => {
      svg += `<text class="node-text" x="${cx(n.id)}" y="${Y + 4 + (i - (words.length - 1) / 2) * 15}">${escapeHtml(w)}</text>`
    })
  }
  return svg + '</svg>'
}

// ---------------------------------------------------------------- go
loadAutomata()
startHeroTape()

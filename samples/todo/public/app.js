const listEl = document.getElementById('list')
const countEl = document.getElementById('count')
const errorEl = document.getElementById('error')
const form = document.getElementById('new-form')
const input = document.getElementById('new-input')
const clearBtn = document.getElementById('clear-completed')
const filterBtns = [...document.querySelectorAll('.filters button')]

let todos = []
let filter = 'all'

const showError = (msg) => { errorEl.textContent = msg; errorEl.hidden = false }
const clearError = () => { errorEl.hidden = true }

async function api(method, pathName, body) {
  const res = await fetch(pathName, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  if (!res.ok) {
    let msg = `Request failed (${res.status})`
    try { const j = await res.json(); if (j.error) msg = j.error } catch { /* ignore */ }
    throw new Error(msg)
  }
  return res.status === 204 ? null : res.json()
}

function visible() {
  if (filter === 'active') return todos.filter((t) => !t.completed)
  if (filter === 'completed') return todos.filter((t) => t.completed)
  return todos
}

function render() {
  listEl.replaceChildren(...visible().map(renderItem))
  const remaining = todos.filter((t) => !t.completed).length
  countEl.textContent = `${remaining} item${remaining === 1 ? '' : 's'} left`
  for (const b of filterBtns) b.classList.toggle('active', b.dataset.filter === filter)
}

function renderItem(t) {
  const li = document.createElement('li')
  li.className = 'item' + (t.completed ? ' done' : '')

  const cb = document.createElement('input')
  cb.type = 'checkbox'
  cb.checked = t.completed
  cb.addEventListener('change', () => toggle(t, cb.checked))

  const title = document.createElement('span')
  title.className = 'title'
  title.textContent = t.title // textContent → XSS-safe
  title.title = 'Double-click to edit'
  title.addEventListener('dblclick', () => beginEdit(t, li, title))

  const del = document.createElement('button')
  del.type = 'button'
  del.className = 'del'
  del.textContent = '×'
  del.setAttribute('aria-label', 'Delete')
  del.addEventListener('click', () => remove(t))

  li.append(cb, title, del)
  return li
}

function beginEdit(t, li, title) {
  const edit = document.createElement('input')
  edit.type = 'text'
  edit.className = 'edit'
  edit.value = t.title
  edit.maxLength = 500
  li.replaceChild(edit, title)
  edit.focus()
  let finished = false
  const commit = async () => {
    if (finished) return
    finished = true
    const v = edit.value.trim()
    if (v && v !== t.title) {
      try { Object.assign(t, await api('PATCH', `/api/todos/${t.id}`, { title: v })) }
      catch (e) { showError(e.message) }
    }
    render()
  }
  edit.addEventListener('blur', commit)
  edit.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') edit.blur()
    if (e.key === 'Escape') { finished = true; render() }
  })
}

async function toggle(t, completed) {
  try { Object.assign(t, await api('PATCH', `/api/todos/${t.id}`, { completed })) }
  catch (e) { showError(e.message) }
  render()
}

async function remove(t) {
  try { await api('DELETE', `/api/todos/${t.id}`); todos = todos.filter((x) => x.id !== t.id); render() }
  catch (e) { showError(e.message) }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const v = input.value.trim()
  if (!v) return
  try {
    todos.push(await api('POST', '/api/todos', { title: v }))
    input.value = ''
    clearError()
    render()
  } catch (err) { showError(err.message) }
})

clearBtn.addEventListener('click', async () => {
  try { await api('DELETE', '/api/todos?completed=true'); todos = todos.filter((t) => !t.completed); render() }
  catch (e) { showError(e.message) }
})

for (const b of filterBtns) b.addEventListener('click', () => { filter = b.dataset.filter; render() })
errorEl.addEventListener('click', clearError)

;(async () => {
  try { todos = await api('GET', '/api/todos'); clearError(); render() }
  catch (e) { showError(e.message) }
})()

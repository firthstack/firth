const $ = (id) => document.getElementById(id)
const errorEl = $('error')
const authView = $('auth-view'), todoView = $('todo-view')
const authForm = $('auth-form'), authEmail = $('auth-email'), authPassword = $('auth-password')
const authSubmit = $('auth-submit'), authToggle = $('auth-toggle'), authModeLabel = $('auth-mode-label')
const whoEl = $('who'), logoutBtn = $('logout')
const listEl = $('list'), countEl = $('count'), form = $('new-form'), input = $('new-input')
const fileInput = $('new-image')
const clearBtn = $('clear-completed'), filterBtns = [...document.querySelectorAll('.filters button')]

let todos = []
let filter = 'all'
let mode = 'login'
let token = localStorage.getItem('todo_token')

const showError = (m) => { errorEl.textContent = m; errorEl.hidden = false }
const clearError = () => { errorEl.hidden = true }

async function api(method, pathName, body) {
  const headers = {}
  const isForm = body instanceof FormData
  if (body && !isForm) headers['Content-Type'] = 'application/json' // browser sets multipart boundary itself
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(pathName, {
    method,
    headers,
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  })
  if (res.status === 401) {
    token = null
    localStorage.removeItem('todo_token')
    showAuth()
    throw new Error('Please log in')
  }
  if (!res.ok) {
    let msg = `Request failed (${res.status})`
    try { const j = await res.json(); if (j.error) msg = j.error } catch { /* ignore */ }
    throw new Error(msg)
  }
  return res.status === 204 ? null : res.json()
}

function showAuth() { authView.hidden = false; todoView.hidden = true }
function showTodos(email) { authView.hidden = true; todoView.hidden = false; whoEl.textContent = email }

// --- auth ---
authToggle.addEventListener('click', (e) => {
  e.preventDefault()
  mode = mode === 'login' ? 'register' : 'login'
  authSubmit.textContent = mode === 'login' ? 'Log in' : 'Register'
  authModeLabel.textContent = mode === 'login' ? 'No account?' : 'Have an account?'
  authToggle.textContent = mode === 'login' ? 'Register' : 'Log in'
  clearError()
})

authForm.addEventListener('submit', async (e) => {
  e.preventDefault()
  const email = authEmail.value.trim()
  const password = authPassword.value
  if (!email || !password) return
  try {
    const out = await api('POST', `/api/auth/${mode}`, { email, password })
    token = out.token
    localStorage.setItem('todo_token', token)
    authPassword.value = ''
    clearError()
    showTodos(out.user.email)
    await load()
  } catch (err) { showError(err.message) }
})

logoutBtn.addEventListener('click', async () => {
  try { await api('POST', '/api/auth/logout') } catch { /* ignore */ }
  token = null
  localStorage.removeItem('todo_token')
  todos = []
  showAuth()
})

// --- todos ---
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

  li.append(cb, title)
  if (t.image_url) {
    const link = document.createElement('a')
    link.href = t.image_url
    link.target = '_blank'
    link.rel = 'noopener'
    const img = document.createElement('img')
    img.className = 'thumb'
    img.src = t.image_url
    img.alt = ''
    img.loading = 'lazy'
    link.append(img)
    li.append(link)
  }
  li.append(del)
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
    const file = fileInput.files[0]
    let created
    if (file) {
      const fd = new FormData()
      fd.append('title', v)
      fd.append('image', file)
      created = await api('POST', '/api/todos', fd)
    } else {
      created = await api('POST', '/api/todos', { title: v })
    }
    todos.push(created)
    input.value = ''
    fileInput.value = ''
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

async function load() {
  try { todos = await api('GET', '/api/todos'); clearError(); render() }
  catch (e) { if (token) showError(e.message) } // a 401 already cleared the token + showed auth
}

// --- bootstrap: validate any stored token, else show the auth view ---
;(async () => {
  if (!token) { showAuth(); return }
  try {
    const me = await api('GET', '/api/auth/me')
    showTodos(me.email)
    await load()
  } catch { /* 401 already cleared token + showed auth */ }
})()

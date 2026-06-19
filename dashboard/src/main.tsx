import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { createInsforgeAuth } from './auth/auth'
import { Api } from './api/client'
import './theme.css'

const auth = createInsforgeAuth(import.meta.env.VITE_INSFORGE_URL, import.meta.env.VITE_INSFORGE_ANON_KEY)
const makeApi = (getToken: () => string | null) => new Api(import.meta.env.VITE_FIRTH_API_URL, getToken)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App auth={auth} makeApi={makeApi} />
  </React.StrictMode>,
)

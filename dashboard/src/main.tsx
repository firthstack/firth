import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { createControlPlaneAuth } from './auth/auth'
import { Api } from './api/client'
import './theme.css'

const auth = createControlPlaneAuth(import.meta.env.VITE_FIRTH_API_URL)
const makeApi = (getToken: () => string | null) => new Api(import.meta.env.VITE_FIRTH_API_URL, getToken)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App auth={auth} makeApi={makeApi} />
  </React.StrictMode>,
)

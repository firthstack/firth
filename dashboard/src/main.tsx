import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { createControlPlaneAuth } from './auth/auth'
import { Api } from './api/client'
import './theme.css'

const apiUrl = import.meta.env.VITE_FIRTH_API_URL
const auth = createControlPlaneAuth(apiUrl)
const makeApi = (
  getToken: () => string | null,
  opts?: { getRefreshToken?: () => string | null; onTokens?: (t: { token: string; refreshToken: string }) => void; onAuthLost?: () => void },
) => new Api(apiUrl, getToken, undefined, opts)

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App auth={auth} makeApi={makeApi} />
  </React.StrictMode>,
)

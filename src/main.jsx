import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Get the base URL from Vite's environment
const baseUrl = import.meta.env.BASE_URL || '/'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App baseUrl={baseUrl} />
  </StrictMode>,
)

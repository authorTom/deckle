import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles/theme.css'
// After theme.css: every palette here overrides the default one it defines.
import './styles/themes.css'
import './styles/global.css'
import './styles/editor.css'
import './styles/print.css'

// What Deckle 2.x's assistant left in this browser. Its settings held provider
// API keys — some lent by a server library on the promise that signing out
// would forget them — and its index held embeddings of notes. The assistant is
// gone, so nothing else would ever clear them.
try {
  for (const key of ['deckle-assistant-settings', 'deckle-queue-settings', 'deckle-height-trevor']) {
    localStorage.removeItem(key)
  }
  indexedDB.deleteDatabase('notes-vault-index')
} catch {
  // Storage blocked (a private window, say): there is nothing to clear.
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

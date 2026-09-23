import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import MessagingMailboxHost from './MessagingMailboxHost'
import RecurrenceCalendarHints from './RecurrenceCalendarHints'
import SystemCalendarEvents from './SystemCalendarEvents'
import './styles.css'
import './manager-theme.css'

try {
  if (window.localStorage.getItem('manager-low-spec-mode') === '1') {
    document.documentElement.classList.add('low-spec')
  }
} catch {
  // Storage may be unavailable in hardened/private browser contexts.
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <MessagingMailboxHost />
    <RecurrenceCalendarHints />
    <SystemCalendarEvents />
  </StrictMode>,
)

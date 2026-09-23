import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import MessagingMailboxHost from './MessagingMailboxHost'
import RecurrenceCalendarHints from './RecurrenceCalendarHints'
import SystemCalendarEvents from './SystemCalendarEvents'
import './styles.css'
import './manager-theme.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <MessagingMailboxHost />
    <RecurrenceCalendarHints />
    <SystemCalendarEvents />
  </StrictMode>,
)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import MessagingMailboxHost from './MessagingMailboxHost'
import RecurrenceCalendarHints from './RecurrenceCalendarHints'
import './styles.css'

// Checklist display normalization is kept here so all checklist views share the same empty-value behavior.
const normalizeChecklistEmptyDisplays = (root: ParentNode = document) => {
  root.querySelectorAll<HTMLInputElement>('.checklist-drawer input').forEach((input) => {
    if (input.placeholder === '—' || input.placeholder === '-') input.placeholder = '0'
  })

  root.querySelectorAll<HTMLSelectElement>('.checklist-drawer select').forEach((select) => {
    Array.from(select.options).forEach((option) => {
      if (option.value === '' && (option.textContent?.trim() === '—' || option.textContent?.trim() === '-')) {
        option.textContent = '0'
      }
    })
  })
}

const checklistEmptyDisplayObserver = new MutationObserver((mutations) => {
  for (const mutation of mutations) {
    if (mutation.type === 'attributes' && mutation.target instanceof HTMLInputElement) {
      const input = mutation.target
      if (input.matches('.checklist-drawer input') && (input.placeholder === '—' || input.placeholder === '-')) {
        input.placeholder = '0'
      }
      continue
    }

    mutation.addedNodes.forEach((node) => {
      if (node instanceof Element) normalizeChecklistEmptyDisplays(node)
    })
  }
})

checklistEmptyDisplayObserver.observe(document.documentElement, {
  childList: true,
  subtree: true,
  attributes: true,
  attributeFilter: ['placeholder'],
})
normalizeChecklistEmptyDisplays()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
    <MessagingMailboxHost />
    <RecurrenceCalendarHints />
  </StrictMode>,
)

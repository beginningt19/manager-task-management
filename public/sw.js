const DEFAULT_PAYLOAD = {
  title: 'Управленски задачи',
  body: 'Има промяна по задача.',
  url: '/',
}

self.addEventListener('install', () => {
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let payload = { ...DEFAULT_PAYLOAD }

  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() }
    } catch {
      payload.body = event.data.text()
    }
  }

  const urgent = Boolean(payload.urgent || payload.type === 'task-reminder')
  const tag = payload.tag || (urgent ? `urgent-${Date.now()}` : 'manager-task-update')

  const options = {
    body: payload.body,
    icon: '/app-icon.svg',
    badge: '/app-icon.svg',
    lang: 'bg',
    dir: 'ltr',
    data: {
      url: payload.url || '/',
      taskId: payload.taskId || null,
      messageId: payload.messageId || null,
      type: payload.type || 'task-update',
    },
    tag,
    timestamp: Date.now(),
    silent: false,
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, options),
  )
})

self.addEventListener('notificationclick', (event) => {
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.notification.close()

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (windows) => {
      const sameOrigin = windows.find((client) => new URL(client.url).origin === self.location.origin)
      if (sameOrigin) {
        if ('navigate' in sameOrigin && sameOrigin.url !== target) await sameOrigin.navigate(target)
        return sameOrigin.focus()
      }
      return clients.openWindow(target)
    }),
  )
})

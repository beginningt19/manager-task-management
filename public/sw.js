const DEFAULT_PAYLOAD = {
  title: 'Административни задачи',
  body: 'Има промяна по задача.',
  url: '/',
}

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
  const tag = payload.tag || (urgent ? `urgent-${Date.now()}` : 'admin-task-update')

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: '/app-icon.svg',
      badge: '/app-icon.svg',
      lang: 'bg',
      data: {
        url: payload.url || '/',
        taskId: payload.taskId || null,
        type: payload.type || 'task-update',
      },
      tag,
      timestamp: Date.now(),
      requireInteraction: urgent,
      renotify: urgent,
      silent: false,
      vibrate: urgent ? [250, 120, 250, 120, 450] : [180, 80, 180],
      actions: urgent
        ? [
            { action: 'open', title: 'Отвори задачата' },
            { action: 'dismiss', title: 'Затвори' },
          ]
        : [{ action: 'open', title: 'Отвори' }],
    }),
  )
})

self.addEventListener('notificationclick', (event) => {
  const action = event.action
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href
  event.notification.close()

  if (action === 'dismiss') return

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

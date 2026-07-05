// AutoFlow Web Push service worker. Deliberately minimal — no asset caching
// or offline shell yet (that's a separate PWA task); this file only exists
// to receive push events while the app isn't open, per the Push API spec
// (https://developer.mozilla.org/en-US/docs/Web/API/Push_API).

self.addEventListener("push", (event) => {
  let payload = { title: "AutoFlow", body: "You have a new notification.", link: "/", tag: "autoflow" };
  if (event.data) {
    try {
      payload = { ...payload, ...event.data.json() };
    } catch {
      payload.body = event.data.text();
    }
  }

  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/logo.png",
      badge: "/logo.png",
      tag: payload.tag,
      data: { link: payload.link },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const link = event.notification.data?.link || "/";

  event.waitUntil(
    (async () => {
      const clientsList = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const existing = clientsList.find((c) => new URL(c.url).pathname === link);
      if (existing) {
        await existing.focus();
        return;
      }
      const anyClient = clientsList[0];
      if (anyClient) {
        await anyClient.focus();
        await anyClient.navigate(link);
        return;
      }
      await self.clients.openWindow(link);
    })()
  );
});

// Browsers occasionally rotate a push subscription's endpoint/keys (e.g.
// expired encryption keys). There's no Convex auth context available inside
// a service worker to persist the new endpoint here, so this just
// re-subscribes at the platform level; the client-side hook
// (hooks/usePushNotifications.ts) re-syncs the current subscription to
// Convex on next foreground load. The old row is harmless — pushSend.ts
// already prunes subscriptions the push service reports as gone.
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(
    self.registration.pushManager.subscribe(event.oldSubscription?.options)
  );
});

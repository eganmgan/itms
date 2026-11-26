const changeKey = 'itms-records-changed'

export function notifyRecordChange() {
  try { localStorage.setItem(changeKey, Array.from(crypto.getRandomValues(new Uint32Array(4))).join('-')) } catch {}
  window.dispatchEvent(new Event(changeKey))
}

export function subscribeRecordChanges(notify: () => void, refreshOnFocus = true) {
  const storage = (event: StorageEvent) => {
    if (event.key === changeKey && event.newValue) notify()
  }
  window.addEventListener(changeKey, notify)
  window.addEventListener('storage', storage)
  if (refreshOnFocus) window.addEventListener('focus', notify)
  return () => {
    window.removeEventListener(changeKey, notify)
    window.removeEventListener('storage', storage)
    if (refreshOnFocus) window.removeEventListener('focus', notify)
  }
}
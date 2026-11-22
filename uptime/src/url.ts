// Userinfo and query strings can carry credentials, so they never reach the UI or a notification.
export const displayUrl = (url: string) => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url.replace(/\/\/[^/@\s]*@/, '//').replace(/[?#].*$/, '')
  }
  const query = parsed.search ? '?…' : ''
  return `${parsed.protocol}//${parsed.host}${parsed.pathname}${query}`
}

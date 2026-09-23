// R01: only these known analytics/attribution parameters may vary without
// changing the selected data set. Keep this one rule shared by content and
// background route gates. Unknown query keys and every hash change stay stale.
const TRACKING_QUERY_KEYS = new Set([
  'gclid', 'dclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid',
  'mc_cid', 'mc_eid', '_ga', '_gl'
])

function isTrackingQueryKey(key) {
  const normalized = String(key).toLowerCase()
  return normalized.startsWith('utm_') || TRACKING_QUERY_KEYS.has(normalized)
}

function routeParts(value) {
  const url = new URL(String(value))
  const query = []
  for (const [key, item] of url.searchParams) {
    if (!isTrackingQueryKey(key)) query.push([key, item])
  }
  return {
    origin: url.origin,
    username: url.username,
    password: url.password,
    pathname: url.pathname,
    hash: url.hash,
    query
  }
}

/** True only when two absolute URLs differ solely in known tracking parameters. */
export function sameRouteIgnoringTracking(expectedUrl, currentUrl) {
  if (typeof expectedUrl !== 'string' || typeof currentUrl !== 'string') return false
  try {
    const expected = routeParts(expectedUrl)
    const current = routeParts(currentUrl)
    return expected.origin === current.origin &&
      expected.username === current.username &&
      expected.password === current.password &&
      expected.pathname === current.pathname &&
      expected.hash === current.hash &&
      JSON.stringify(expected.query) === JSON.stringify(current.query)
  } catch {
    return false
  }
}

/** Route identity without a URL is opaque and remains governed by identity checks. */
export function routeIdentityMatchesUrl(routeIdentity, currentUrl) {
  const expectedUrl = routeIdentity && typeof routeIdentity === 'object' && typeof routeIdentity.url === 'string'
    ? routeIdentity.url
    : ''
  return !expectedUrl || sameRouteIgnoringTracking(expectedUrl, currentUrl)
}

/**
 * Which modifier key to print in front of a shortcut.
 *
 * `navigator.platform` is deprecated and, worse, wrong where it matters: on
 * iPadOS it answers "iPad", so anyone with a keyboard attached was told to
 * press Ctrl for a key their keyboard calls ⌘. Prefer the modern hint, fall
 * back to the user-agent string, and treat iOS as Apple rather than as other.
 */
function isApplePlatform(): boolean {
  if (typeof navigator === 'undefined') return false

  const uaData = (
    navigator as Navigator & { userAgentData?: { platform?: string } }
  ).userAgentData
  if (uaData?.platform) return /mac|ios|ipad|iphone/i.test(uaData.platform)

  // iPadOS reports a desktop user-agent, so the touch-point count is what
  // separates an iPad from an actual Mac. Either way the key is ⌘.
  const ua = navigator.userAgent
  if (/mac|iphone|ipad|ipod/i.test(ua)) return true
  return /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
}

export const IS_APPLE = isApplePlatform()

/** The modifier as the user's own keyboard prints it. */
export const MOD_KEY = IS_APPLE ? '⌘' : 'Ctrl'

/** Alt, as the user's own keyboard prints it. */
export const ALT_KEY = IS_APPLE ? '⌥' : 'Alt'

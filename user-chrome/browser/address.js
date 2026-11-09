function normalizeAddress(input) {
  const value = String(input || '').trim()
  if (!value || value === 'browser://newtab') return 'browser://newtab'
  if (/^(?:localhost|(?:\d{1,3}\.){3}\d{1,3}|\[[\da-f:]+\])(?::\d+)?(?:[/?#]|$)/i.test(value)) {
    return new URL(`http://${value}`).toString()
  }
  if (/^[\p{L}\p{M}\p{N}_-]+(?:\.[\p{L}\p{M}\p{N}_-]+)+(?::\d+)?(?:[/?#]|$)/u.test(value)) {
    return new URL(`https://${value}`).toString()
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Apenas URLs HTTP(S) sao permitidas.')
    return url.toString()
  }
  return `https://www.google.com/search?q=${encodeURIComponent(value)}`
}
module.exports = { normalizeAddress }

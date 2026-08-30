const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/i

export function normalizeProviderOverride(input = {}) {
  const modelProvider = normalizeOptionalId(input.modelProvider, 'modelProvider')
  const model = normalizeOptionalText(input.model, 'model')

  return Object.freeze({
    ...(modelProvider ? { modelProvider } : {}),
    ...(model ? { model } : {})
  })
}

export function applyProviderOverride(params, override) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new TypeError('params must be an object')
  }
  const normalized = normalizeProviderOverride(override)
  return { ...params, ...normalized }
}

function normalizeOptionalId(value, field) {
  if (value == null || value === '') return null
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)
  const trimmed = value.trim()
  if (!PROVIDER_ID_PATTERN.test(trimmed)) throw new TypeError(`${field} contains unsupported characters`)
  return trimmed
}

function normalizeOptionalText(value, field) {
  if (value == null || value === '') return null
  if (typeof value !== 'string') throw new TypeError(`${field} must be a string`)
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 128) throw new TypeError(`${field} is invalid`)
  return trimmed
}

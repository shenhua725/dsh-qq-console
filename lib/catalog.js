/**
 * Model catalog normalisation.
 *
 * DSH returns reasoning efforts as `{ id, name, description }` objects.  The
 * QQ console persists effort IDs as strings, so flattening must never call
 * String() on the object itself (that is what produced "[object Object]").
 *
 * WorkBuddy publishes its full model catalog to
 * `~/.dsh/.workbuddy-ai-catalog.json` even while signed out.  Those cached
 * models are useful in the settings picker, but they need an explicit source
 * label because they are not necessarily routable until WorkBuddy is signed
 * in.
 */

import fs from 'node:fs'
import path from 'node:path'

function clean(value) {
  return String(value ?? '').trim()
}

export function normalizeEffort(value) {
  if (typeof value === 'string') {
    const id = value.trim()
    return id ? { id, name: id } : null
  }
  if (value && typeof value === 'object') {
    const id = clean(value.id ?? value.value ?? value.effort ?? value.name)
    if (!id) return null
    return {
      id,
      name: clean(value.name ?? value.label ?? value.id ?? value.value) || id,
      ...(clean(value.description) ? { description: clean(value.description) } : {}),
    }
  }
  return null
}

export function normalizeEfforts(values, fallbackDefault = '') {
  const list = Array.isArray(values) ? values : []
  const efforts = []
  const effortNames = {}
  for (const value of list) {
    const row = normalizeEffort(value)
    if (!row || efforts.includes(row.id)) continue
    efforts.push(row.id)
    effortNames[row.id] = row.name
  }
  const defaultEffort = normalizeEffort(fallbackDefault)?.id ?? ''
  if (defaultEffort && !efforts.includes(defaultEffort)) {
    efforts.push(defaultEffort)
    effortNames[defaultEffort] = normalizeEffort(fallbackDefault)?.name ?? defaultEffort
  }
  return { efforts, effortNames, defaultEffort: defaultEffort || efforts[0] || '' }
}

/** Flatten the live DSH `modelCatalog()` result. */
export function flattenCatalog(catalog) {
  const out = []
  for (const group of catalog?.groups ?? []) {
    const provider = clean(group?.provider ?? group?.id ?? group?.name)
    if (!provider) continue
    for (const model of group?.models ?? []) {
      const id = clean(model?.model ?? model?.id ?? model?.name)
      if (!id) continue
      const rawEfforts = Array.isArray(model?.reasoning?.efforts)
        ? model.reasoning.efforts
        : Array.isArray(model?.efforts) ? model.efforts : []
      const effortInfo = normalizeEfforts(
        rawEfforts,
        model?.reasoning?.defaultEffort ?? model?.defaultEffort ?? '',
      )
      out.push({
        short: clean(model?.short ?? model?.name ?? id).slice(0, 12),
        provider,
        model: id,
        full: clean(model?.name ?? model?.displayName ?? model?.full ?? id),
        efforts: effortInfo.efforts,
        effortNames: effortInfo.effortNames,
        defaultEffort: effortInfo.defaultEffort,
        origin: 'live',
        sourceLabel: '实时目录',
      })
    }
  }
  return out
}

function providerFromSource(source, fallbackProvider) {
  const head = clean(source).split(':', 1)[0]
  return head || fallbackProvider
}

/**
 * Flatten one WorkBuddy-style cache document.  Exported so the offline test
 * can exercise it without touching the user's home directory.
 */
export function flattenCachedCatalog(doc, { provider, sourceLabel }) {
  const out = []
  const entries = doc?.entries && typeof doc.entries === 'object'
    ? Object.values(doc.entries)
    : []
  for (const entry of entries) {
    const entryProvider = providerFromSource(entry?.source, provider)
    for (const model of entry?.models ?? []) {
      const id = clean(model?.id ?? model?.model ?? model?.name)
      if (!id) continue
      const reasoning = model?.reasoning ?? {}
      const declared = Array.isArray(reasoning.supportedEfforts)
        ? reasoning.supportedEfforts
        : Array.isArray(model?.efforts) ? model.efforts : []
      const declaredDefault = reasoning.defaultEffort ?? model?.defaultEffort ?? ''
      const effortInfo = normalizeEfforts(declared, declaredDefault)
      out.push({
        short: clean(model?.short ?? model?.name ?? id).slice(0, 12),
        provider: entryProvider || provider,
        model: id,
        full: clean(model?.name ?? model?.displayName ?? id),
        efforts: effortInfo.efforts,
        effortNames: effortInfo.effortNames,
        defaultEffort: effortInfo.defaultEffort,
        origin: 'cache',
        sourceLabel,
        availability: 'cached',
      })
    }
  }
  return out
}

/** Read WorkBuddy's cached catalogs from the DSH home directory. */
export function readWorkbuddyCatalog(home) {
  if (!home) return []
  const files = [
    ['.workbuddy-ai-catalog.json', 'workbuddy-ai', 'WorkBuddy AI 缓存（需登录）'],
    ['.workbuddy-catalog.json', 'workbuddy', 'WorkBuddy 缓存（需登录）'],
  ]
  const out = []
  for (const [name, provider, sourceLabel] of files) {
    const file = path.join(home, name)
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
      out.push(...flattenCachedCatalog(doc, { provider, sourceLabel }))
    } catch {
      // Missing or partially written cache is normal while WorkBuddy starts.
    }
  }
  return out
}

/** Merge catalogs, keeping the first (live) entry for each provider/model. */
export function mergeCatalogEntries(...catalogs) {
  const out = []
  const seen = new Set()
  for (const catalog of catalogs) {
    for (const row of catalog ?? []) {
      const provider = clean(row?.provider)
      const model = clean(row?.model)
      if (!provider || !model) continue
      const key = `${provider}:${model}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push(row)
    }
  }
  return out
}

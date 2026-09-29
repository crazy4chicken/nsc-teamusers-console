import type { RouteRecordRaw } from 'vue-router'

/**
 * Aggregation point for the feature areas.
 *
 * Every area declares its own screens under `src/views/<area>/`: `routes.ts`
 * default-exports `AreaRoute[]` and `menu.ts` default-exports `AreaMenuItem[]`.
 * This module discovers those files at build time, so adding or removing an area
 * needs no edit here, in the router or in the app shell — a missing directory or
 * a directory without one of the two files is perfectly valid.
 */

declare module 'vue-router' {
  interface RouteMeta {
    /** Reachable without a session. */
    public?: boolean
    /** Document title. */
    title?: string
    /** Grant(s) required to enter the route; any match grants access. */
    permission?: string | string[]
    /** Sidebar section the route belongs to. */
    section?: 'me' | 'admin'
  }
}

/** A route record contributed by an area. Paths are absolute. */
export type AreaRoute = RouteRecordRaw

/** A sidebar entry contributed by an area. */
export interface AreaMenuItem {
  /** Stable identifier, unique across all areas. */
  key: string
  label: string
  /** Absolute path of the route the entry opens. */
  path: string
  group: 'self' | 'admin'
  /** Omit for an entry every signed-in user may see. */
  permission?: string | string[]
  /** Ascending sort within the group; defaults to 0, ties break on label. */
  order?: number
}

type AreaRoutesModule = { default: AreaRoute[] }
type AreaMenuModule = { default: AreaMenuItem[] }

const routeModules = import.meta.glob<AreaRoutesModule>('../views/**/routes.ts', { eager: true })
const menuModules = import.meta.glob<AreaMenuModule>('../views/**/menu.ts', { eager: true })

/** Scope breadth, so a broader grant also satisfies a narrower requirement. */
const SCOPE_RANK: Record<string, number> = { own: 0, team: 1, any: 2, '*': 3 }

/**
 * A grant satisfies a requirement when both keys have the same shape and every
 * grant segment is either `*`, equal to the requirement's segment, or — for the
 * scope segment — broader (`iam:teams:any` covers `iam:teams:team`, which in turn
 * covers `iam:teams:own`). The caller strips the leading `!` of a deny key.
 */
function keyMatches(grant: string, required: string): boolean {
  const grantSegments = grant.split(':')
  const requiredSegments = required.split(':')
  if (grantSegments.length !== requiredSegments.length) return false
  const scopeIndex = requiredSegments.length - 1
  return grantSegments.every((segment, index) => {
    if (segment === '*' || segment === requiredSegments[index]) return true
    if (index !== scopeIndex) return false
    const grantedRank = SCOPE_RANK[segment]
    const requiredRank = SCOPE_RANK[requiredSegments[index]]
    return grantedRank !== undefined && requiredRank !== undefined && grantedRank >= requiredRank
  })
}

/**
 * Whether `grantedKeys` satisfies `permission`. `undefined` marks an ungated
 * entry; an array is satisfied by any one of its keys; an empty array is a
 * deliberate denial. An explicit deny for a required key always wins.
 */
export function hasPermission(
  permission: string | string[] | undefined,
  grantedKeys: string[]
): boolean {
  if (permission === undefined) return true
  const required = typeof permission === 'string' ? [permission] : permission
  return required.some((key) => {
    const matches = grantedKeys.filter((grant) => keyMatches(grant.replace(/^!/, ''), key))
    if (matches.some((grant) => grant.startsWith('!'))) return false
    return matches.length > 0
  })
}

/** Module ids in a stable order, so the route table and the sidebar do not depend on readdir order. */
function moduleIds<T>(modules: Record<string, T>): string[] {
  return Object.keys(modules).sort()
}

function buildAreaRoutes(): AreaRoute[] {
  const collected: AreaRoute[] = []
  const owners = new Map<string, string>()
  const names = new Map<string, string>()
  for (const id of moduleIds(routeModules)) {
    const entries = routeModules[id].default
    if (!Array.isArray(entries)) {
      throw new Error(`[registry] ${id} must default-export an array of routes`)
    }
    for (const route of entries) {
      const owner = owners.get(route.path)
      if (owner) {
        throw new Error(
          `[registry] duplicate route path "${route.path}" declared by ${owner} and ${id}`
        )
      }
      owners.set(route.path, id)
      // A repeated name is not fatal to vue-router but silently re-points every
      // `push({ name })` at the last declaration, so it is treated as a conflict.
      if (route.name !== undefined) {
        const name = String(route.name)
        const nameOwner = names.get(name)
        if (nameOwner) {
          throw new Error(`[registry] duplicate route name "${name}" declared by ${nameOwner} and ${id}`)
        }
        names.set(name, id)
      }
      collected.push(route)
    }
  }
  return collected
}

function buildMenuGroups(): {
  self: AreaMenuItem[]
  admin: AreaMenuItem[]
} {
  const groups: { self: AreaMenuItem[]; admin: AreaMenuItem[] } = { self: [], admin: [] }
  const owners = new Map<string, string>()
  for (const id of moduleIds(menuModules)) {
    const entries = menuModules[id].default
    if (!Array.isArray(entries)) {
      throw new Error(`[registry] ${id} must default-export an array of menu items`)
    }
    for (const item of entries) {
      if (item.group !== 'self' && item.group !== 'admin') {
        throw new Error(
          `[registry] ${id}: menu item "${item.key}" must use group "self" or "admin"`
        )
      }
      if (!item.key || !item.path) {
        throw new Error(`[registry] ${id}: every menu item needs a non-empty key and path`)
      }
      const owner = owners.get(item.key)
      if (owner) {
        throw new Error(`[registry] duplicate menu key "${item.key}" declared by ${owner} and ${id}`)
      }
      owners.set(item.key, id)
      groups[item.group].push(item)
    }
  }
  for (const group of [groups.self, groups.admin]) {
    group.sort(
      (a, b) => (a.order ?? 0) - (b.order ?? 0) || a.label.localeCompare(b.label, 'zh-Hans-CN')
    )
  }
  return groups
}

/** Every route contributed by an area, ready to nest under the app shell. */
export const areaRoutes: AreaRoute[] = buildAreaRoutes()

/** Sidebar entries per section, sorted by `order` then label. */
export const menuGroups: {
  readonly self: readonly AreaMenuItem[]
  readonly admin: readonly AreaMenuItem[]
} = buildMenuGroups()

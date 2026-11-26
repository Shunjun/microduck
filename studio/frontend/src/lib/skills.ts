import type { Skills } from './model'

export function skillEntries(result: Skills): Skills['skills'] {
  // robot.skills deliberately omits built_in when that list is empty.
  return [
    ...result.skills,
    ...(result.built_in ?? []).map((name) => ({ name, overridden: false, duration: undefined })),
  ]
}

export interface SkillAvailability {
  enabled: boolean
  skills?: string[]
}

export function quickSkillNames(result: Skills, policies: SkillAvailability): string[] {
  if (!policies.enabled) return []
  const names = new Set([...(policies.skills ?? []), ...(result.built_in ?? [])])
  return skillEntries(result).filter((skill) => names.has(skill.name)).map((skill) => skill.name)
}

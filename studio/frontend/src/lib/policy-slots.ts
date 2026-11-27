import type { Entry } from './model'

export const policySlots = [
  ['walk', '行走', '摇杆控制前进、后退和转向'],
  ['stand', '站立', '静止时维持站立平衡'],
  ['sitstand', '坐下 / 起立', '在坐姿和站姿之间切换'],
  ['ground_pick', '地面拾取', '俯身执行拾取动作'],
  ['kick_left', '左脚踢球', '执行一次左脚踢球'],
  ['kick_right', '右脚踢球', '执行一次右脚踢球'],
  ['roulade', '前滚翻', '执行一次前滚翻'],
] as const

export function modelsForSlot(entries: Entry[], slot: string) {
  return entries.filter(({ manifest: m }) => {
    if (m.slot !== slot) return false
    if (['walk', 'stand'].includes(slot)) return m.kind === 'perpetual' && m.command.encoding === 'constant'
    if (slot === 'sitstand') return m.kind === 'perpetual' && m.command.encoding === 'posture_flag'
    if (slot === 'ground_pick') return m.kind === 'perpetual' && m.command.encoding === 'phase'
    return m.kind === 'episodic' && m.command.encoding === 'constant'
  })
}

export function trialSkill(slot: string) {
  if (slot === 'sitstand') return 'sit_toggle'
  return ['ground_pick', 'kick_left', 'kick_right', 'roulade'].includes(slot) ? slot : null
}

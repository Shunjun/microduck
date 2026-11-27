import type { Entry } from './model'

export function actionName(entry: Pick<Entry, 'alias' | 'manifest'>): string {
  return entry.alias?.trim() || entry.manifest.name
}

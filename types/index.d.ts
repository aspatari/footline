export type Footline = {
  model: string
  effort?: string
  branch?: string
  isDirty: boolean
  addedDirs: string[]
  tokens: number
  window: number
  fiveHour?: number
  week?: number
}

declare module 'claude-code' {
  interface PluginState {
    'footline': { line: Shaped<Footline | null>; sessionDirs: string[] }
  }
}

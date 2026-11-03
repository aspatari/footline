export type Footline = {
  model: string
  effort?: string
  branch?: string
  isDirty: boolean
  addedDirs: string[]
  home?: string
  tokens: number
  window: number
  fiveHour?: number
  fiveHourLeft?: string
  week?: number
  weekLeft?: string
}

// A GitHub repository is owner/name, a GitLab one host/group/name; `forge` is
// set for GitLab alone, so refs stored before it existed read as GitHub.
export type FootlinePrRef = { forge?: 'gitlab'; repo: string; number: number }

export type FootlinePr = FootlinePrRef & {
  url: string
  state: 'OPEN' | 'MERGED' | 'CLOSED'
  isDraft: boolean
  checks?: 'pass' | 'fail' | 'pending'
  isBranch: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'footline': { line: Shaped<Footline | null>; sessionDirs: string[]; sessionPrs: FootlinePrRef[]; prs: Shaped<FootlinePr[]> }
  }
}

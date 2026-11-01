import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Footline } from '../types'

// The shape's tag: a line stored by an older version of this mod reads as null.
const line = atom({ plugin: 'footline', key: 'line' } as const, null, { shape: 'line-3' })
// What /add-dir added in this session; no call on $ answers it, only the event.
const sessionDirs = atom({ plugin: 'footline', key: 'sessionDirs' } as const, [])

const GIT_POLL_MS = 10_000
const GIT_TIMEOUT_MS = 3_000
const BAR_CELLS = 5
const DIRS_SHOWN = 3
const DIR_NAME_MAX = 14

// What the engine's left of the footer can take: the mode, its hint and `← 4 agents`.
const FOOTER_LEFT = 52
const COMPACT_COLUMNS = 108
const UNMEASURED_COLUMNS = 160

const shortCount = (n: number) => (n >= 1e6 ? `${+(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1e3)}k`)

// claude-opus-5-5 -> opus 5.5; anything else (an alias, a gateway's id) as it came.
const shortModel = (model: string) => {
  const match = model.replace(/\[.*\]$/, '').match(/^claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-|$)/)

  return match ? `${match[1]} ${match[2]}${match[3] ? `.${match[3]}` : ''}` : model
}

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

// Time left to a limit's reset: 30m, 3h, 3d5h. Minutes round up, so the last
// minute reads 1m; nothing where the time has passed or is unknown.
const timeLeft = (resetsAt: string | undefined, now: number) => {
  const minutes = Math.ceil((Date.parse(resetsAt ?? '') - now) / 60_000)

  if (!(minutes > 0)) {
    return undefined
  }

  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)

  return days > 0 ? `${days}d${hours > 0 ? `${hours}h` : ''}` : hours > 0 ? `${hours}h` : `${minutes}m`
}

const baseName = (path: string) => path.replace(/[/\\]+$/, '').split(/[/\\]/).pop() || path

// +sparkle +lib-foo +2
const dirNames = (dirs: readonly string[]) => {
  const shown = dirs.slice(0, DIRS_SHOWN).map(dir => `+${clip(baseName(dir), DIR_NAME_MAX)}`)
  const rest = dirs.length - shown.length

  return [...shown, ...(rest > 0 ? [`+${rest}`] : [])].join(' ')
}

// Theme keys, so the shades follow the terminal theme.
const heat = (percent: number) => (percent > 75 ? 'error' : percent > 50 ? 'warning' : 'success')

// A track of heavy cells in half steps: ━━╸──
const bar = (percent: number) => {
  const halves = Math.round((Math.min(Math.max(percent, 0), 100) / 100) * BAR_CELLS * 2)
  const whole = Math.floor(halves / 2)
  const half = halves % 2
  const empty = BAR_CELLS - whole - half

  return { filled: '━'.repeat(whole) + (half ? '╸' : ''), empty: '─'.repeat(empty) }
}

const readGit = async ($: EngineInterface) => {
  try {
    const { exitCode, stdout } = await $.process.run(
      ['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch'],
      { timeoutMs: GIT_TIMEOUT_MS },
    )

    if (exitCode !== 0) {
      return { isDirty: false }
    }

    const rows = stdout.split('\n').filter(Boolean)
    const field = (name: string) => rows.find(row => row.startsWith(`# branch.${name} `))?.split(' ')[2]
    const head = field('head')
    const branch = head === '(detached)' ? field('oid')?.slice(0, 7) : head

    return { branch, isDirty: rows.some(row => !row.startsWith('#')) }
  } catch {
    return { isDirty: false }
  }
}

const readSettings = async ($: EngineInterface, model: string) => {
  const settings = (await $.settings.read()) as {
    effortLevel?: string
    modelSettings?: Record<string, { effortLevel?: string }>
    permissions?: { additionalDirectories?: string[] }
  }

  return {
    effort: settings.modelSettings?.[model.replace(/\[.*\]$/, '')]?.effortLevel ?? settings.effortLevel,
    dirs: settings.permissions?.additionalDirectories ?? [],
  }
}

// What the settings said last, and what the last turn really ran on. A turn's
// report wins (the engine may downgrade), until the settings move again.
let settingsEffort: string | undefined
let turnEffort: string | undefined

const refresh = async ($: EngineInterface) => {
  const [model, { context, rateLimits }, git] = await Promise.all([
    $.session.model(),
    $.session.usage(),
    readGit($),
  ])
  const { effort: fromSettings, dirs: settingsDirs } = await readSettings($, model)
  const addedDirs = [...new Set([...settingsDirs, ...(await read($, sessionDirs))])]

  if (fromSettings !== settingsEffort) {
    settingsEffort = fromSettings
    turnEffort = undefined
  }

  const now = await $.clock.now()
  const limit = (kind: string) => rateLimits.find(candidate => candidate.kind === kind)
  const next: Footline = {
    model,
    effort: turnEffort ?? fromSettings,
    branch: git.branch,
    isDirty: git.isDirty,
    addedDirs,
    tokens: context.tokens ?? 0,
    window: context.window,
    fiveHour: limit('five_hour')?.percentUsed,
    fiveHourLeft: timeLeft(limit('five_hour')?.resetsAt, now),
    week: limit('seven_day')?.percentUsed,
    weekLeft: timeLeft(limit('seven_day')?.resetsAt, now),
  }

  // Only a real change redraws: every open session polls this.
  await update($, line, previous => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next))
}

let poll: Timer | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await refresh($)
    // Another session or a shell can switch the branch of a shared checkout.
    poll?.cancel()
    poll = $.clock.every(GIT_POLL_MS, () => {
      refresh($).catch(() => {})
    })

    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    await refresh($)

    return next(e)
  })

  on('classic.Stop', async ($, e, next) => {
    turnEffort = e.effort?.level ?? turnEffort
    await refresh($)

    return next(e)
  })

  on('classic.PostModelSwitch', async ($, e, next) => {
    turnEffort = undefined
    await refresh($)

    return next(e)
  })

  on('classic.ConfigChange', async ($, e, next) => {
    await refresh($)

    return next(e)
  })

  on('classic.DirectoryAdded', async ($, e, next) => {
    await update($, sessionDirs, dirs => [...(dirs ?? []), e.directory])
    await refresh($)

    return next(e)
  })

  on('classic.CwdChanged', async ($, e, next) => {
    await refresh($)

    return next(e)
  })

  // The dim mode labels at the right of the prompt footer, drawn as our own
  // tree so each part can take its colour.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const drawn = await read($, line)

    if (drawn === null) {
      return next(e)
    }

    const { Text } = $.ui.resolve(e)
    const columns = e.viewport?.columns ?? UNMEASURED_COLUMNS
    const isTiny = columns < COMPACT_COLUMNS
    const contextPercent = drawn.window > 0 ? (drawn.tokens / drawn.window) * 100 : 0
    const contextValue = isTiny
      ? `${Math.round(contextPercent)}%`
      : `${shortCount(drawn.tokens)}/${shortCount(drawn.window)}`
    const limits = [
      ...(drawn.fiveHour === undefined ? [] : [['5h', drawn.fiveHour, drawn.fiveHourLeft] as const]),
      ...(drawn.week === undefined ? [] : [['wk', drawn.week, drawn.weekLeft] as const]),
    ]
    const branchText = drawn.branch ? `${clip(drawn.branch, isTiny ? 14 : 20)}${drawn.isDirty ? '*' : ''}` : ''

    // Laid out by the row's real length: bars first go, then the names of the
    // directories, so the footer stays on one row as long as it can.
    const count = drawn.addedDirs.length > 0 ? `+${drawn.addedDirs.length}` : ''
    const plain = [
      branchText && `\uE0A0 ${branchText}${count && ` ${count}`}`,
      `${shortModel(drawn.model)} ${drawn.effort ?? ''}`,
      `ctx ${contextValue}`,
      ...limits.map(([label, percent, left]) => `${label} ${Math.round(percent)}%${left ? ` ${left}` : ''}`),
    ].join('  ').length
    const barsWidth = (limits.length + 1) * (BAR_CELLS + 1)
    const hasBars = columns >= FOOTER_LEFT + plain + barsWidth
    const names = dirNames(drawn.addedDirs)
    const showsNames = hasBars && columns >= FOOTER_LEFT + plain + barsWidth + names.length - count.length

    const gauge = (label: string, percent: number, value: string, left?: string) => {
      const { filled, empty } = bar(percent)

      return (
        <Text key={label}>
          {'  '}
          <Text dimColor>{label} </Text>
          {hasBars ? <Text color={heat(percent)}>{filled}</Text> : ''}
          {hasBars ? <Text dimColor>{empty} </Text> : ''}
          <Text color={heat(percent)}>{value}</Text>
          {left ? <Text dimColor> {left}</Text> : ''}
        </Text>
      )
    }

    return (
      <Text>
        {e.props.modes.length > 0 ? <Text dimColor>{e.props.modes.join(' & ')}{'  '}</Text> : ''}
        {drawn.branch ? (
          <Text key="branch" color="merged">
            {'\uE0A0 '}
            {clip(drawn.branch, isTiny ? 14 : 20)}
            {drawn.isDirty ? <Text color="warning">*</Text> : ''}
          </Text>
        ) : (
          ''
        )}
        {drawn.addedDirs.length > 0 ? (
          <Text key="dirs" dimColor>
            {drawn.branch ? ' ' : ''}
            {showsNames ? names : count}
          </Text>
        ) : (
          ''
        )}
        {drawn.branch || drawn.addedDirs.length > 0 ? '  ' : ''}
        <Text key="model" color="planMode" weight="bold">
          {shortModel(drawn.model)}
        </Text>
        {drawn.effort ? <Text key="effort" color="suggestion"> {drawn.effort}</Text> : ''}
        {gauge('ctx', contextPercent, contextValue)}
        {limits.map(([label, percent, left]) => gauge(label, percent, `${Math.round(percent)}%`, left))}
      </Text>
    )
  })
}

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, Timer } from 'claude-code'

import type { Footline, FootlinePr, FootlinePrRef } from '../types'

// The shape's tag: a line stored by an older version of this mod reads as null.
const line = atom({ plugin: 'footline', key: 'line' } as const, null, { shape: 'line-4' })
// What /add-dir added in this session; no call on $ answers it, only the event.
// Kept twice, as the engine keeps the directories past both of these: the state
// survives a reload of this module, the variable survives a /clear.
const sessionDirs = atom({ plugin: 'footline', key: 'sessionDirs' } as const, [])
let clearProofDirs: string[] = []
// Pull requests: the current branch's, and the ones this session's tools made or
// worked on, kept the same two ways as the directories.
const sessionPrs = atom({ plugin: 'footline', key: 'sessionPrs' } as const, [])
let clearProofPrs: FootlinePrRef[] = []
const prs = atom({ plugin: 'footline', key: 'prs' } as const, [], { shape: 'prs-1' })

const GIT_POLL_MS = 10_000
const GIT_TIMEOUT_MS = 3_000
const BAR_CELLS = 5
const DIRS_SHOWN = 3
const DIR_NAME_MAX = 14
const PR_POLL_MS = 60_000
const PR_TIMEOUT_MS = 15_000
const PRS_SHOWN = 3

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

const PR_COLOR = { OPEN: 'success', DRAFT: 'inactive', MERGED: 'merged', CLOSED: 'error' } as const
const CHECK = {
  pass: { glyph: '✓', color: 'success' },
  fail: { glyph: '✗', color: 'error' },
  pending: { glyph: '●', color: 'warning' },
} as const

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
// A gh command that names or makes a pull request; the number is its argument.
const GH_PR = /\bgh\s+pr\s+(create|edit|merge|ready|view|checks|comment|review|close|reopen|diff)\b([^\n;&|]*)/
const PR_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/
const REPO_FLAG = /(?:--repo|-R)[\s=]+([\w.-]+\/[\w.-]+)/

let lastPrPoll = -Infinity
let prsAreStale = true

const samePr = (a: FootlinePrRef, b: FootlinePrRef) => a.repo === b.repo && a.number === b.number

// What a finished tool call says about a pull request: Bash running gh pr, or
// a GitHub MCP tool on one. `home` is the session's repository, for a bare number.
export const prsTouched = (tool: string, input: Record<string, unknown>, text: string, home?: string) => {
  const found: FootlinePrRef[] = []
  const add = (repo: string | undefined, number: number) => {
    if (repo && number > 0) found.push({ repo, number })
  }

  if (tool === 'Bash') {
    const match = String(input.command ?? '').match(GH_PR)

    if (!match) return found

    // Only the command's own argument counts, never an address in its body.
    const [, verb, rest = ''] = match
    const argument = rest.match(/^\s+([^\s"']+)/)?.[1] ?? ''
    const url = argument.match(PR_URL)
    const number = argument.match(/^#?(\d+)$/)

    if (url) add(url[1], Number(url[2]))
    else if (number) add(rest.match(REPO_FLAG)?.[1] ?? home, Number(number[1]))
    else if (verb === 'create') {
      const made = text.match(PR_URL)

      if (made) add(made[1], Number(made[2]))
    }
  } else if (/pull_request/i.test(tool) && input.owner && input.repo) {
    const number = Number(input.pull_number ?? input.pullNumber ?? 0)
    const made = text.match(PR_URL)

    if (number) add(`${input.owner}/${input.repo}`, number)
    else if (made) add(made[1], Number(made[2]))
  }

  return found
}

const remember = async ($: EngineInterface, refs: FootlinePrRef[]) => {
  const fresh = refs.filter(ref => !clearProofPrs.some(known => samePr(known, ref)))

  if (fresh.length === 0) return false

  clearProofPrs = [...fresh, ...clearProofPrs]
  prsAreStale = true
  await update($, sessionPrs, known => [...fresh, ...(known ?? []).filter(k => !fresh.some(f => samePr(f, k)))])

  return true
}

const readHome = async ($: EngineInterface) => {
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'remote', 'get-url', 'origin'], { timeoutMs: GIT_TIMEOUT_MS })

    return exitCode === 0 ? stdout.trim().match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/)?.[1] : undefined
  } catch {
    return undefined
  }
}

type GhPr = {
  number: number
  url: string
  state: FootlinePr['state']
  isDraft: boolean
  statusCheckRollup?: { status?: string; conclusion?: string; state?: string }[]
}

const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR'])

const checksOf = (rollup: GhPr['statusCheckRollup'] = []): FootlinePr['checks'] => {
  const results = rollup.map(check =>
    FAILED.has(check.conclusion ?? check.state ?? '')
      ? 'fail'
      : (check.status && check.status !== 'COMPLETED') || ['PENDING', 'EXPECTED'].includes(check.state ?? '')
        ? 'pending'
        : 'pass',
  )

  return results.includes('fail') ? 'fail' : results.includes('pending') ? 'pending' : results.length ? 'pass' : undefined
}

const viewPr = async ($: EngineInterface, args: string[]) => {
  try {
    const { exitCode, stdout } = await $.process.run(
      ['gh', 'pr', 'view', ...args, '--json', 'number,url,state,isDraft,statusCheckRollup'],
      { timeoutMs: PR_TIMEOUT_MS },
    )

    return exitCode === 0 ? (JSON.parse(stdout) as GhPr) : undefined
  } catch {
    return undefined
  }
}

// The badges to draw: the branch's pull request first, then the ones the session
// touched, newest first. A merged or closed one is final and not asked again.
const refreshPrs = async ($: EngineInterface, branch: string | undefined) => {
  const now = await $.clock.now()

  if (!prsAreStale && now - lastPrPoll < PR_POLL_MS) return

  lastPrPoll = now
  prsAreStale = false

  const home = await readHome($)
  const known = await read($, prs)
  const touched = [...new Set([...(await read($, sessionPrs)), ...clearProofPrs].map(ref => `${ref.repo}#${ref.number}`))]
    .map(key => ({ repo: key.split('#')[0]!, number: Number(key.split('#')[1]) }))
  const onBranch = branch ? await viewPr($, []) : undefined
  const badge = (repo: string, pr: GhPr, isBranch: boolean): FootlinePr => ({
    repo,
    number: pr.number,
    url: pr.url,
    state: pr.state,
    isDraft: pr.isDraft,
    checks: checksOf(pr.statusCheckRollup),
    isBranch,
  })
  const next: FootlinePr[] = []

  if (onBranch && home) next.push(badge(home, onBranch, true))

  for (const ref of touched) {
    if (next.length >= PRS_SHOWN) break
    if (next.some(pr => samePr(pr, ref))) continue

    const cached = known.find(pr => samePr(pr, ref))
    const isFinal = cached && cached.state !== 'OPEN'
    const pr = isFinal ? undefined : await viewPr($, [String(ref.number), '--repo', ref.repo])

    if (pr) next.push(badge(ref.repo, pr, false))
    else if (cached) next.push({ ...cached, isBranch: false })
  }

  await update($, prs, previous => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next))
}

let settingsEffort: string | undefined
let turnEffort: string | undefined

const refresh = async ($: EngineInterface, withPrs = false) => {
  const [model, { context, rateLimits }, git] = await Promise.all([
    $.session.model(),
    $.session.usage(),
    readGit($),
  ])
  const { effort: fromSettings, dirs: settingsDirs } = await readSettings($, model)
  const addedDirs = [...new Set([...settingsDirs, ...(await read($, sessionDirs)), ...clearProofDirs])]

  if (fromSettings !== settingsEffort) {
    settingsEffort = fromSettings
    turnEffort = undefined
  }

  const home = await readHome($)
  const now = await $.clock.now()
  const limit = (kind: string) => rateLimits.find(candidate => candidate.kind === kind)
  const next: Footline = {
    model,
    effort: turnEffort ?? fromSettings,
    branch: git.branch,
    isDirty: git.isDirty,
    addedDirs,
    home,
    tokens: context.tokens ?? 0,
    window: context.window,
    fiveHour: limit('five_hour')?.percentUsed,
    fiveHourLeft: timeLeft(limit('five_hour')?.resetsAt, now),
    week: limit('seven_day')?.percentUsed,
    weekLeft: timeLeft(limit('seven_day')?.resetsAt, now),
  }

  // Only a real change redraws: every open session polls this.
  await update($, line, previous => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next))

  if (withPrs) await refreshPrs($, git.branch)
}

let poll: Timer | undefined

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A resumed session: the pull requests its earlier turns worked on.
    try {
      const home = await readHome($)
      const messages = await $.session.messages()

      await remember(
        $,
        messages.flatMap(message =>
          message.toolUses.flatMap(use => prsTouched(use.tool, use.input, use.text ?? '', home)),
        ).reverse(),
      )
    } catch {}

    await refresh($, true)
    // Another session or a shell can switch the branch of a shared checkout.
    poll?.cancel()
    poll = $.clock.every(GIT_POLL_MS, () => {
      refresh($, true).catch(() => {})
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
    clearProofDirs = [...clearProofDirs, e.directory]
    await update($, sessionDirs, dirs => [...(dirs ?? []), e.directory])
    await refresh($)

    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const result = await next(e)

    try {
      const { tool, ...input } = e as unknown as { tool: string } & Record<string, unknown>
      const touched = prsTouched(String(tool), input, result.text ?? '', await readHome($))

      if (await remember($, touched)) {
        // Shown at once by number; the next tick of the poll fills in its state.
        await update($, prs, shown => [
          ...touched
            .filter(ref => !(shown ?? []).some(pr => samePr(pr, ref)))
            .map(ref => ({ ...ref, url: '', state: 'OPEN' as const, isDraft: false, isBranch: false })),
          ...(shown ?? []),
        ].slice(0, PRS_SHOWN))
      }
    } catch {}

    return result
  })

  on('classic.CwdChanged', async ($, e, next) => {
    await refresh($)

    return next(e)
  })

  // The dim mode labels at the right of the prompt footer, drawn as our own
  // tree so each part can take its colour.
  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const drawn = await read($, line)
    const badges = await read($, prs)

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
    // #392 for the session's own repository, name#12 for another one.
    const prLabel = (pr: FootlinePr) => `${pr.repo === drawn.home ? '' : pr.repo.split('/')[1]}#${pr.number}`
    const prsText = badges.map(pr => `${prLabel(pr)}${pr.checks ? '✓' : ''}`).join(' ')
    const plain = [
      branchText && `\uE0A0 ${branchText}${count && ` ${count}`}`,
      prsText,
      `${shortModel(drawn.model)} ${drawn.effort ?? ''}`,
      `ctx ${contextValue}`,
      ...limits.map(([label, percent, left]) => `${label} ${Math.round(percent)}%${left ? ` ${left}` : ''}`),
    ]
      .filter(Boolean)
      .join('  ').length
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
        {badges.length > 0 ? (
          <Text key="prs">
            {badges.map((pr, i) => (
              <Text key={`${pr.repo}#${pr.number}`}>
                {i > 0 ? ' ' : ''}
                <Text color={PR_COLOR[pr.isDraft && pr.state === 'OPEN' ? 'DRAFT' : pr.state]}>{prLabel(pr)}</Text>
                {pr.checks ? <Text color={CHECK[pr.checks].color}>{CHECK[pr.checks].glyph}</Text> : ''}
              </Text>
            ))}
            {'  '}
          </Text>
        ) : (
          ''
        )}
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

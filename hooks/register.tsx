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
const prs = atom({ plugin: 'footline', key: 'prs' } as const, [], { shape: 'prs-2' })

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

const PR_COLOR = { OPEN: 'success', DRAFT: 'inactive' } as const
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

// Pull and merge requests: GitHub through gh, GitLab through glab. A GitHub
// repository is `owner/name`; a GitLab one carries its host, `host/group/name`,
// as glab's -R takes it.
type Home = { forge: Forge; repo: string }
type Forge = 'github' | 'gitlab'

const forgeOf = (ref: { forge?: 'gitlab' }): Forge => ref.forge ?? 'github'

// A command that names or makes one; the number is its own argument.
const GH_PR = /\bgh\s+pr\s+(create|edit|merge|ready|view|checks|comment|review|close|reopen|diff)\b([^\n;&|]*)/
const GLAB_MR = /\bglab\s+mr\s+(create|update|merge|view|note|approve|revoke|close|reopen|diff|checkout)\b([^\n;&|]*)/
const PR_URL = /github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/
const MR_URL = /https?:\/\/([\w.-]+\/[\w./-]+?)\/-\/merge_requests\/(\d+)/
const REPO_FLAG = /(?:--repo|-R)[\s=]+(\S+)/

let lastPrPoll = -Infinity
let prsAreStale = true
// Merged or closed: done with, so never drawn and never asked about again.
let finished: string[] = []
const keyOf = (ref: FootlinePrRef) => `${forgeOf(ref)} ${ref.repo}#${ref.number}`

const samePr = (a: FootlinePrRef, b: FootlinePrRef) =>
  forgeOf(a) === forgeOf(b) && a.repo === b.repo && a.number === b.number

const refOf = (forge: Forge, repo: string, number: number): FootlinePrRef =>
  forge === 'gitlab' ? { forge, repo, number } : { repo, number }

// A GitLab -R names its project as a path, an address or with its host.
const gitlabRepo = (flag: string, home?: Home) => {
  const path = flag.replace(/^https?:\/\//, '').replace(/\.git$/, '')

  return path.split('/').length > 2 || home?.forge !== 'gitlab' ? path : `${home.repo.split('/')[0]}/${path}`
}

// What a finished tool call says about a pull or merge request: Bash running
// gh pr or glab mr, or a GitHub MCP tool on one. `home` answers a bare number.
export const prsTouched = (tool: string, input: Record<string, unknown>, text: string, home?: Home) => {
  const found: FootlinePrRef[] = []

  if (tool === 'Bash') {
    const command = String(input.command ?? '')

    for (const [forge, pattern, address] of [
      ['github', GH_PR, PR_URL],
      ['gitlab', GLAB_MR, MR_URL],
    ] as const) {
      const match = command.match(pattern)

      if (!match) continue

      // Only the command's own argument counts, never an address in its body.
      const [, verb, rest = ''] = match
      const argument = rest.match(/^\s+([^\s"']+)/)?.[1] ?? ''
      const url = argument.match(address)
      const number = argument.match(/^[#!]?(\d+)$/)
      const flag = rest.match(REPO_FLAG)?.[1]
      const made = verb === 'create' ? text.match(address) : null

      if (url) found.push(refOf(forge, url[1]!, Number(url[2])))
      else if (number) {
        const repo = flag
          ? forge === 'gitlab'
            ? gitlabRepo(flag, home)
            : flag
          : home?.forge === forge
            ? home.repo
            : undefined

        if (repo) found.push(refOf(forge, repo, Number(number[1])))
      } else if (made) found.push(refOf(forge, made[1]!, Number(made[2])))
    }
  } else if (/pull_request/i.test(tool) && input.owner && input.repo) {
    const number = Number(input.pull_number ?? input.pullNumber ?? 0)
    const made = text.match(PR_URL)

    if (number) found.push(refOf('github', `${input.owner}/${input.repo}`, number))
    else if (made) found.push(refOf('github', made[1]!, Number(made[2])))
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

// The session's repository, from origin: github.com is GitHub, any other host
// is taken for GitLab, which glab answers or leaves alone.
const readHome = async ($: EngineInterface): Promise<Home | undefined> => {
  try {
    const { exitCode, stdout } = await $.process.run(['git', 'remote', 'get-url', 'origin'], { timeoutMs: GIT_TIMEOUT_MS })
    const match = exitCode === 0 ? stdout.trim().match(/^(?:\w+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/](?:\d+\/)?(.+?)(?:\.git)?\/?$/) : null

    if (!match) return undefined

    const [, host, path] = match

    return host === 'github.com' ? { forge: 'github', repo: path! } : { forge: 'gitlab', repo: `${host}/${path}` }
  } catch {
    return undefined
  }
}

type Review = Omit<FootlinePr, 'repo' | 'forge' | 'isBranch'>

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

const PIPELINE: Record<string, FootlinePr['checks']> = {
  success: 'pass',
  failed: 'fail',
  canceled: 'fail',
  running: 'pending',
  pending: 'pending',
  created: 'pending',
  preparing: 'pending',
  scheduled: 'pending',
  waiting_for_resource: 'pending',
}

type GhPr = {
  number: number
  url: string
  state: FootlinePr['state']
  isDraft: boolean
  statusCheckRollup?: { status?: string; conclusion?: string; state?: string }[]
}

type GlabMr = {
  iid: number
  web_url: string
  state: string
  draft?: boolean
  work_in_progress?: boolean
  head_pipeline?: { status?: string } | null
  pipeline?: { status?: string } | null
}

const run = async <T,>($: EngineInterface, argv: string[]) => {
  try {
    const { exitCode, stdout } = await $.process.run(argv, { timeoutMs: PR_TIMEOUT_MS })

    return exitCode === 0 && stdout.trim().startsWith('{') ? (JSON.parse(stdout) as T) : undefined
  } catch {
    // Not installed, not signed in, or no answer in time: nothing to show.
    return undefined
  }
}

// One request's state; `ref` absent asks for the current branch's.
const viewPr = async ($: EngineInterface, forge: Forge, ref?: FootlinePrRef): Promise<Review | undefined> => {
  if (forge === 'github') {
    const pr = await run<GhPr>($, [
      'gh', 'pr', 'view',
      ...(ref ? [String(ref.number), '--repo', ref.repo] : []),
      '--json', 'number,url,state,isDraft,statusCheckRollup',
    ])

    return pr && { number: pr.number, url: pr.url, state: pr.state, isDraft: pr.isDraft, checks: checksOf(pr.statusCheckRollup) }
  }

  const mr = await run<GlabMr>($, ['glab', 'mr', 'view', ...(ref ? [String(ref.number), '-R', ref.repo] : []), '--output', 'json'])
  const STATES: Record<string, FootlinePr['state']> = { opened: 'OPEN', merged: 'MERGED', closed: 'CLOSED', locked: 'CLOSED' }
  const state = mr && STATES[mr.state]

  return mr && state
    ? {
        number: mr.iid,
        url: mr.web_url,
        state,
        isDraft: Boolean(mr.draft ?? mr.work_in_progress),
        checks: PIPELINE[(mr.head_pipeline ?? mr.pipeline)?.status ?? ''],
      }
    : undefined
}

// The badges to draw: the branch's request first, then the ones the session
// touched, newest first. A merged or closed one is final and not asked again.
const refreshPrs = async ($: EngineInterface, branch: string | undefined) => {
  const now = await $.clock.now()

  if (!prsAreStale && now - lastPrPoll < PR_POLL_MS) return

  lastPrPoll = now
  prsAreStale = false

  const home = await readHome($)
  const known = await read($, prs)
  const touched = [...(await read($, sessionPrs)), ...clearProofPrs].filter(
    (ref, i, all) => all.findIndex(other => samePr(other, ref)) === i,
  )
  const onBranch = branch && home ? await viewPr($, home.forge) : undefined
  const next: FootlinePr[] = []

  if (onBranch && home && onBranch.state === 'OPEN') {
    next.push({ ...refOf(home.forge, home.repo, onBranch.number), ...onBranch, isBranch: true })
  }

  for (const ref of touched) {
    if (next.length >= PRS_SHOWN) break
    if (next.some(pr => samePr(pr, ref))) continue

    if (finished.includes(keyOf(ref))) continue

    const cached = known.find(pr => samePr(pr, ref))
    const review = await viewPr($, forgeOf(ref), ref)

    if (review && review.state !== 'OPEN') {
      finished = [...finished, keyOf(ref)]
      continue
    }

    if (review) next.push({ ...ref, ...review, isBranch: false })
    else if (cached) next.push({ ...cached, isBranch: false })
  }

  await update($, prs, previous => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next))
}

// What the settings said last, and what the last turn really ran on. A turn's
// report wins (the engine may downgrade), until the settings move again.
// macOS has open, Linux xdg-open; whichever is there takes the address.
const openInBrowser = async ($: EngineInterface, url: string) => {
  for (const opener of ['open', 'xdg-open']) {
    try {
      if ((await $.process.run([opener, url], { timeoutMs: GIT_TIMEOUT_MS })).exitCode === 0) return
    } catch {}
  }
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
    home: home?.repo,
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

    // The line at once; the requests after it, as gh or glab can take seconds.
    await refresh($)
    refresh($, true).catch(() => {})
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
            .filter(ref => !finished.includes(keyOf(ref)) && !(shown ?? []).some(pr => samePr(pr, ref)))
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

    const { Box, Button, Text } = $.ui.resolve(e)
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
    // #392 or !128 for the session's own repository, name#12 for another one.
    const prLabel = (pr: FootlinePr) =>
      `${pr.repo === drawn.home ? '' : pr.repo.split('/').at(-1)}${pr.forge === 'gitlab' ? '!' : '#'}${pr.number}`
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
    // On a GitHub branch with a PR the engine adds ` · PR #305` on the left.
    const branchPr = badges.find(pr => pr.isBranch && pr.forge !== 'gitlab')
    // and keeps a gap of its own between the two sides.
    const left = FOOTER_LEFT + (branchPr ? ` · PR #${branchPr.number}`.length + 2 : 0)
    const hasBars = columns >= left + plain + barsWidth
    const names = dirNames(drawn.addedDirs)
    const showsNames = hasBars && columns >= left + plain + barsWidth + names.length - count.length

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

    const badgeColor = (pr: FootlinePr) => PR_COLOR[pr.isDraft ? 'DRAFT' : 'OPEN']

    // A row of parts: a Button (a badge) cannot sit inside a Text.
    return (
      <Box flexDirection="row" flexShrink={0}>
        <Text key="head">
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
        </Text>
        {badges.map((pr, i) => [
          pr.url ? (
            // A click opens it in the browser. A Button, not a Link: where the
            // engine does not trust the terminal with OSC 8 (herdr, tmux), a
            // Link draws its whole address after the text.
            <Button key={`open ${pr.url}`} plain onPress={() => openInBrowser($, pr.url)}>
              <Text color={badgeColor(pr)}>{prLabel(pr)}</Text>
            </Button>
          ) : (
            // Just named by a tool; dim until the poll brings its state.
            <Text key={`named ${pr.repo}#${pr.number}`} dimColor>
              {prLabel(pr)}
            </Text>
          ),
          <Text key={`after ${pr.repo}#${pr.number}`}>
            {pr.checks ? <Text color={CHECK[pr.checks].color}>{CHECK[pr.checks].glyph}</Text> : ''}
            {i === badges.length - 1 ? '  ' : ' '}
          </Text>,
        ])}
        <Text key="tail">
          <Text key="model" color="planMode" weight="bold">
            {shortModel(drawn.model)}
          </Text>
          {drawn.effort ? <Text key="effort" color="suggestion"> {drawn.effort}</Text> : ''}
          {gauge('ctx', contextPercent, contextValue)}
          {limits.map(([label, percent, left]) => gauge(label, percent, `${Math.round(percent)}%`, left))}
        </Text>
      </Box>
    )
  })
}

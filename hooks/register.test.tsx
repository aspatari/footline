import { expect, test } from 'claude-code/testing'

const GIT_DIRTY = '# branch.oid abcdef1234\n# branch.head feat-typed-settings\n1 .M N... 100644 100644 100644 a b file.ts\n'

const NOW = 1_800_000_000_000

const opened: string[][] = []
let ghPrs: Record<string, unknown> = {}
let glabMrs: Record<string, unknown> = {}
let remote = 'git@github.com:acme/shop.git'

const glab = (iid: number, state: string, pipeline?: string, draft = false) => ({
  iid,
  web_url: `https://git.example.com/team/shop/-/merge_requests/${iid}`,
  state,
  draft,
  head_pipeline: pipeline ? { status: pipeline } : null,
})
let messages: unknown[] = []
let toolText = ''

const gh = (number: number, state: string, rollup: unknown[] = [], isDraft = false) => ({
  number,
  url: `https://github.com/acme/shop/pull/${number}`,
  state,
  isDraft,
  statusCheckRollup: rollup,
})

const seed = (
  on: any,
  { stdout = GIT_DIRTY, exitCode = 0, dirs = [] as string[], fiveHourResetsAt = undefined as string | undefined, weekResetsAt = undefined as string | undefined } = {},
) => {
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: 620400, window: 1000000 },
      rateLimits: [
        { kind: 'five_hour', percentUsed: 23.4, resetsAt: fiveHourResetsAt },
        { kind: 'seven_day', percentUsed: 81, resetsAt: weekResetsAt },
        { kind: 'spend_limit', percentUsed: 5 },
      ],
    },
  }))
  on('settings.read', () => ({
    value: {
      effortLevel: 'xhigh',
      modelSettings: { 'claude-opus-5-5': { effortLevel: 'high' } },
      permissions: { additionalDirectories: dirs },
    },
  }))
  on('process.run', (_: unknown, e: { argv: string[] }) => {
    const command = e.argv.join(' ')

    if (e.argv[0] === 'open') {
      opened.push([...e.argv])

      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    }
    if (command.startsWith('git remote')) return { value: { exitCode: 0, stdout: `${remote}\n`, stderr: '' } }
    if (command.startsWith('glab mr view')) {
      const mr = glabMrs[e.argv[3] && !e.argv[3].startsWith('-') ? `${e.argv[3]} ${e.argv[5] ?? ''}`.trim() : 'branch']

      return { value: mr ? { exitCode: 0, stdout: JSON.stringify(mr), stderr: '' } : { exitCode: 1, stdout: '', stderr: 'no open merge request' } }
    }
    if (command.startsWith('gh pr view')) {
      const pr = ghPrs[e.argv[3] && !e.argv[3].startsWith('--') ? e.argv[3] : 'branch']

      return { value: pr ? { exitCode: 0, stdout: JSON.stringify(pr), stderr: '' } : { exitCode: 1, stdout: '', stderr: 'no pull requests found' } }
    }

    return { value: { exitCode, stdout, stderr: '' } }
  })
  on('session.messages', () => ({ value: messages }))
  on('tool.call', () => ({ result: {}, text: toolText }))
  on('classic.DirectoryAdded', () => ({}))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('clock.now', () => ({ value: NOW }))
  on('session.measure', (_: unknown, e: { changed: string[] }) => ({ changed: e.changed }))
  on('ui.render', { component: 'SessionMode' }, ($: any, e: any) => {
    const { Text } = $.ui.resolve(e)

    return <Text>{e.props.modes.join(' & ')}</Text>
  })
}

const draw = async ($: any, columns: number) => {
  await $.session.measure({ context: { window: 1000000 }, rateLimits: [], changed: ['context'] })
  const ui = await $.ui.mount({
    plugin: 'footline',
    surface: 'terminal',
    component: 'SessionMode',
    props: { modes: [] },
    viewport: { columns, rows: 40 },
  })
  const texts = (await ui.findAll({ type: "Text" })) as { text: string; props: { color?: string; dimColor?: boolean } }[]

  return { texts, all: texts.map(t => t.text).join('') }
}

test('a wide footer has branch, short model, effort, and bars for context and both limits', async ($, on) => {
  seed(on)
  const { all, texts } = await draw($, 140)

  expect(all).toContain('feat-typed-settings')
  expect(all).toContain('*')
  expect(all).toContain('opus 5.5')
  expect(all).toContain(' high')
  expect(all).toContain('620k/1M')
  expect(all).toContain('5h ')
  expect(all).toContain('23%')
  expect(all).toContain('wk ')
  expect(all).toContain('81%')
  expect(all).toContain('━━━──')
  expect(all).not.toContain('5%')
  expect(texts.find(t => t.text === '81%')?.props.color).toBe('error')
  expect(texts.find(t => t.text === '620k/1M')?.props.color).toBe('warning')
  expect(texts.find(t => t.text === '23%')?.props.color).toBe('success')
})

test('a narrower footer drops the bars, the narrowest clips the branch too', async ($, on) => {
  seed(on)
  const compact = await draw($, 110)

  expect(compact.all).not.toContain('━')
  expect(compact.all).toContain('feat-typed-settings')

  const tiny = await draw($, 90)

  expect(tiny.all).toContain('feat-typed-se…')
  expect(tiny.all).toContain('62%')
})

test('outside a git repository the branch is left out and the rest stays', async ($, on) => {
  seed(on, { stdout: '', exitCode: 128 })
  const { all } = await draw($, 140)

  expect(all).not.toContain('')
  expect(all).toContain('opus 5.5')
})

test('a detached head shows its short commit', async ($, on) => {
  seed(on, { stdout: '# branch.oid abcdef1234567\n# branch.head (detached)\n' })
  const { all } = await draw($, 140)

  expect(all).toContain('abcdef1')
  expect(all).not.toContain('*')
})

test('directories from settings and /add-dir stand by name beside the branch, without doubles', async ($, on) => {
  seed(on, { dirs: ['/work/sparkle/', '/work/shared'] })
  await $.classic.DirectoryAdded({ directory: '/work/lib-foo', source: 'slash_command' })
  await $.classic.DirectoryAdded({ directory: '/work/shared', source: 'slash_command' })
  const { all } = await draw($, 170)

  expect(all).toContain('+sparkle +shared +lib-foo')
  expect(all).not.toContain('+shared +shared')
})

test('past three directories the rest are counted, and a tight row shows the count alone', async ($, on) => {
  seed(on, { dirs: ['/a/one', '/a/two', '/a/three', '/a/four', '/a/five'] })

  expect((await draw($, 170)).all).toContain('+one +two +three +2')

  const tight = (await draw($, 130)).all

  expect(tight).toContain('+5')
  expect(tight).not.toContain('+one')
})

test('no added directory draws no plus', async ($, on) => {
  seed(on)

  expect((await draw($, 160)).all).not.toContain('+')
})

test('a long branch gives up the bars before the footer would wrap, a short one keeps them', async ($, on) => {
  seed(on)

  expect((await draw($, 135)).all).not.toContain('━')
  expect((await draw($, 136)).all).toContain('━')
})

const MINUTE = 60_000
const after = (minutes: number) => new Date(NOW + minutes * MINUTE).toISOString()

test('each limit shows the time left to its reset: minutes, hours, days with hours', async ($, on) => {
  seed(on, { fiveHourResetsAt: after(30), weekResetsAt: after((3 * 24 + 5) * 60) })

  const { all } = await draw($, 170)

  expect(all).toContain('23% 30m')
  expect(all).toContain('81% 3d5h')
})

test('a whole number of days reads without hours, and hours without minutes', async ($, on) => {
  seed(on, { fiveHourResetsAt: after(3 * 60 + 20), weekResetsAt: after(2 * 24 * 60) })

  const { all } = await draw($, 170)

  expect(all).toContain('23% 3h')
  expect(all).not.toContain('3h20')
  expect(all).toContain('81% 2d')
  expect(all).not.toContain('2d0h')
})

test('a reset already past, or none reported, draws no time', async ($, on) => {
  seed(on, { fiveHourResetsAt: after(-5) })

  const { all } = await draw($, 170)

  expect(all).toContain('23%')
  expect(/23% \S/.test(all)).toBe(false)
  expect(/81% \S/.test(all)).toBe(false)
})

test('a directory from /add-dir stays through /clear, which empties the session state', async ($, on) => {
  let isCleared = false

  seed(on)
  ;(on as any)('state.get', { plugin: 'footline', key: 'sessionDirs' }, (_: unknown, e: unknown, next: (e: unknown) => unknown) =>
    isCleared ? { value: {} } : next(e),
  )

  await $.classic.DirectoryAdded({ directory: '/work/lib-foo', source: 'slash_command' })
  isCleared = true

  expect((await draw($, 170)).all).toContain('+lib-foo')
})

const start = ($: any) => $.session.start({ cwd: '/work/shop', source: 'startup' })

test('the branch pull request shows by number, coloured by its state, with its checks', async ($, on) => {
  ghPrs = { branch: gh(392, 'OPEN', [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS' }]) }
  messages = []
  seed(on)
  await start($)
  const { all, texts } = await draw($, 190)

  expect(all).toContain('#392●')
  expect(texts.find(t => t.text === '#392')?.props.color).toBe('success')
  expect(texts.find(t => t.text === '●')?.props.color).toBe('warning')
})

test('a pull request the session edits with gh shows even off its branch, and leaves once it is merged', async ($, on) => {
  ghPrs = { '392': gh(392, 'MERGED', [{ status: 'COMPLETED', conclusion: 'SUCCESS' }]) }
  messages = []
  toolText = ''
  seed(on)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'cd /w && gh pr edit 392 --body-file /tmp/b.md' })

  await start($)
  const { all, texts } = await draw($, 190)

  expect(all).not.toContain('#392')
  expect(texts.length).toBeGreaterThan(0)
})

test('gh pr create is read from the address it prints, and failing checks show a cross', async ($, on) => {
  ghPrs = { '401': gh(401, 'OPEN', [{ status: 'COMPLETED', conclusion: 'FAILURE' }]) }
  messages = []
  toolText = 'https://github.com/acme/shop/pull/401\n'
  seed(on)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'gh pr create --title x --body "see https://github.com/other/repo/pull/7"' })
  await start($)
  const { all } = await draw($, 190)

  expect(all).toContain('#401✗')
  expect(all).not.toContain('#7')
})

test('a resumed session finds the pull requests its earlier turns worked on', async ($, on) => {
  ghPrs = { '388': gh(388, 'OPEN', [], true) }
  messages = [{ role: 'assistant', text: '', toolUses: [{ tool_use_id: 't', tool: 'Bash', input: { command: 'gh pr view 388 --json url' } }] }]
  seed(on)
  await start($)
  const { texts } = await draw($, 190)

  expect(texts.filter(t => t.text === '#388').at(-1)?.props.color).toBe('inactive')
})

test('commands that only mention a pull request do not add it', async ($, on) => {
  ghPrs = { '5': gh(5, 'OPEN') }
  messages = []
  toolText = 'https://github.com/acme/shop/pull/5'
  seed(on)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'git log --oneline | grep "#5"' })
  await start($)

  expect((await draw($, 190)).all).not.toContain('#5')
})

test('on GitLab the branch merge request shows as !number with its pipeline', async ($, on) => {
  remote = 'git@git.example.com:team/shop.git'
  glabMrs = { branch: glab(128, 'opened', 'running') }
  messages = []
  seed(on)
  await start($)
  const { all, texts } = await draw($, 190)

  remote = 'git@github.com:acme/shop.git'
  expect(all).toContain('!128●')
  expect(texts.filter(t => t.text === '!128').at(-1)?.props.color).toBe('success')
})

test('glab mr commands add the merge requests they name or create, read with the project glab needs', async ($, on) => {
  remote = 'https://git.example.com/team/shop.git'
  glabMrs = {
    '131 git.example.com/team/shop': glab(131, 'merged', 'success'),
    '140 git.example.com/team/shop': glab(140, 'opened', 'failed', true),
  }
  messages = []
  toolText = 'https://git.example.com/team/shop/-/merge_requests/140\n'
  seed(on)
  await start($)
  await $.tool.call({ tool: 'Bash', command: 'glab mr merge 131 --yes' })
  await $.tool.call({ tool: 'Bash', command: 'glab mr create --fill --description "after !99"' })
  await start($)
  const { all, texts } = await draw($, 200)

  remote = 'git@github.com:acme/shop.git'
  expect(all).toContain('!140✗')
  expect(all).not.toContain('!131')
  expect(all).not.toContain('99')
  expect(texts.filter(t => t.text === '!140').at(-1)?.props.color).toBe('inactive')
})

test('without glab, or signed out, a GitLab repository draws no badge and the rest stays', async ($, on) => {
  remote = 'git@git.example.com:team/shop.git'
  glabMrs = {}
  messages = []
  seed(on)
  await start($)
  const { all } = await draw($, 190)

  remote = 'git@github.com:acme/shop.git'
  expect(all).not.toContain('!')
  expect(all).toContain('opus 5.5')
})

test('a request a tool just named is drawn dim until its state is read', async ($, on) => {
  ghPrs = { '777': gh(777, 'MERGED') }
  messages = []
  toolText = ''
  seed(on)
  await $.tool.call({ tool: 'Bash', command: 'gh pr view 777' })
  const { texts } = await draw($, 190)
  const badge = texts.filter(t => t.text === '#777').at(-1)

  expect(badge?.props.color).toBeUndefined()
  expect(badge?.props.dimColor).toBe(true)
})

test('pressing a badge opens its address in the browser', async ($, on) => {
  opened.length = 0
  ghPrs = { branch: gh(392, 'OPEN') }
  messages = []
  seed(on)
  await start($)
  await draw($, 190)
  const ui = await $.ui.mount({ plugin: 'footline', surface: 'terminal', component: 'SessionMode', props: { modes: [] }, viewport: { columns: 190, rows: 40 } })

  await ui.press({ key: 'open https://github.com/acme/shop/pull/392' })
  expect(opened).toContainEqual(['open', 'https://github.com/acme/shop/pull/392'])
})

test('a merged branch request is not drawn', async ($, on) => {
  ghPrs = { branch: gh(512, 'MERGED', [{ status: 'COMPLETED', conclusion: 'SUCCESS' }]) }
  messages = []
  seed(on)
  await start($)

  expect((await draw($, 190)).all).not.toContain('#512')
})

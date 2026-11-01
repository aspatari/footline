import { expect, test } from 'claude-code/testing'

const GIT_DIRTY = '# branch.oid abcdef1234\n# branch.head feat-typed-settings\n1 .M N... 100644 100644 100644 a b file.ts\n'

const NOW = 1_800_000_000_000

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
  on('process.run', () => ({ value: { exitCode, stdout, stderr: '' } }))
  on('classic.DirectoryAdded', () => ({}))
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
  const texts = (await ui.findAll({ type: 'Text' })) as { text: string; props: { color?: string } }[]

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

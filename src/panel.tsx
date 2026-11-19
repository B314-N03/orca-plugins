// No build step: Orca strips the types and compiles the JSX when the panel loads.
import {
  atom,
  Badge,
  Box,
  Button,
  Callout,
  Code,
  EmptyState,
  Heading,
  IconButton,
  Input,
  plugin,
  read,
  Row,
  set,
  Spinner,
  Stack,
  Switch,
  Text,
  type PanelContext,
} from 'orca'

import { CHANGED, REQUESTS, type AddAnswer, type Snapshot } from './protocol.ts'
import { checkedLabel, footerText, rowsOf, sinceLabel, type RowView } from './view.ts'

const snapshot = atom<Snapshot | null>(null)
const draftName = atom('')
const draftUrl = atom('')
const formError = atom<string | null>(null)
const checking = atom(false)

const apply = (next: Snapshot) => set(snapshot, next)

const settle = (answer: AddAnswer) => {
  if (!answer.ok) return set(formError, answer.message)
  set(formError, null)
  apply(answer.snapshot)
}

async function add() {
  const answer = await plugin.request(REQUESTS.add, { name: read(draftName).trim(), url: read(draftUrl).trim() })
  settle(answer)
  if (answer.ok) {
    set(draftName, '')
    set(draftUrl, '')
  }
}

async function remove(name: string) {
  settle(await plugin.request(REQUESTS.remove, { name }))
}

async function checkNow() {
  set(checking, true)
  try {
    apply(await plugin.request(REQUESTS.check, undefined, { timeoutMs: 30_000 }))
  } finally {
    set(checking, false)
  }
}

async function setOff(isOff: boolean) {
  apply(await plugin.request(REQUESTS.setOff, { isOff }))
}

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: PanelContext): void {
  ctx.subscriptions.push(plugin.on(CHANGED, apply))
  void plugin.request(REQUESTS.snapshot).then(apply)
}

function DeploymentRow({ row, now }: { row: RowView; now: number }) {
  return (
    <Box border padding="sm" radius="md">
      <Stack gap="xs">
        <Row justify="between">
          <Row gap="xs" wrap>
            <Text tone={row.tone} weight="semibold">
              {row.icon} {row.name}
            </Text>
            <Badge tone={row.tone}>{row.health}</Badge>
            {row.since === null ? null : (
              <Text muted size="xs">
                {sinceLabel(row.since, now)}
              </Text>
            )}
          </Row>
          <IconButton icon="delete" label={`Remove ${row.name}`} variant="ghost" size="xs" onPress={() => remove(row.name)} />
        </Row>
        <Text muted={row.health === 'up'} size="sm">
          {row.detail}
        </Text>
        {row.spark ? <Code>{row.spark}</Code> : null}
        <Text muted size="xs" truncate>
          {row.url}
        </Text>
      </Stack>
    </Box>
  )
}

function AddForm() {
  const error = read(formError)
  return (
    <Stack gap="xs">
      <Heading level={3}>Add deployment</Heading>
      <Row gap="xs">
        <Input label="Name" placeholder="staging" value={read(draftName)} onChange={value => set(draftName, value)} />
        <Input
          label="Health URL"
          placeholder="https://…/health"
          value={read(draftUrl)}
          invalid={error !== null}
          onChange={value => set(draftUrl, value)}
          onSubmit={add}
        />
      </Row>
      <Row justify="between">
        {error ? <Text tone="danger" size="sm">{error}</Text> : <Text muted size="xs">Re-adding a name replaces its URL.</Text>}
        <Button icon="add" onPress={add} disabled={!read(draftName).trim() || !read(draftUrl).trim()}>
          Add
        </Button>
      </Row>
    </Stack>
  )
}

export default function Panel() {
  const current = read(snapshot)
  if (current === null) return <Spinner label="Loading deployments" />
  const rows = rowsOf(current)
  const now = Date.now()
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Uptime</Heading>
        <Switch label="Checking" checked={!current.isOff} onChange={checked => setOff(!checked)} />
      </Row>
      {current.isOff ? (
        <Callout tone="neutral" title="uptime is off">
          No checks, no notifications and no status bar item. Last known results below.
        </Callout>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState title="No deployments yet" description="Add a health endpoint below." icon="activity" />
      ) : (
        <Stack gap="sm">
          {rows.map(row => (
            <DeploymentRow key={row.key} row={row} now={now} />
          ))}
        </Stack>
      )}
      <Row justify="between">
        {current.checkedAt === null ? (
          <Text muted size="xs">
            not checked yet · {footerText(current)}
          </Text>
        ) : (
          <Text muted size="xs">
            {checkedLabel(current.checkedAt, now)} · {footerText(current)}
          </Text>
        )}
        <Button icon="refresh" variant="outline" size="sm" disabled={current.isOff || read(checking)} onPress={checkNow}>
          Check now
        </Button>
      </Row>
      <AddForm />
    </Stack>
  )
}

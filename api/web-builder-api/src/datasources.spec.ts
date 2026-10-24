import { describe, expect, it } from 'vitest'
import { DataSource, createProject } from '@spsedu360/engine/model'
import { createFlow, createStep } from '@spsedu360/engine/flow'
import { Connector, readSchema, runQuery } from './datasources'
import { runServerFlow } from './compute'
import { EnvSecrets } from './secrets'
import { KvStore } from './storage'

const source: DataSource = {
  id: 'ds1',
  name: 'School DB',
  type: 'postgres',
  credential: 'SCHOOL_DB',
  readOnly: true,
  schema: { students: ['id', 'name', 'grade'] },
}
const secrets = {
  SCHOOL_DB: 'postgresql://user:pass@db.example.com:5432/school',
}

/** Fake database that records statements and answers from a table of rows. */
function fakeDb(rows: Record<string, unknown>[] = [], fail?: string) {
  const calls: { sql: string; params: unknown[]; url: string }[] = []
  let closed = 0
  const connector: Connector = async (_source, url) => ({
    run: async (sql, params) => {
      calls.push({ sql, params, url })
      if (fail) throw new Error(fail)
      return rows
    },
    close: async () => void closed++,
  })
  return { connector, calls, closed: () => closed }
}

describe('runQuery', () => {
  it('sends parameterized SQL with the credential URL and closes the connection', async () => {
    const db = fakeDb([{ id: 1, name: 'Asha' }])
    const rows = await runQuery(
      source,
      {
        operation: 'select',
        from: { table: 'students' },
        fields: [{ expr: { column: 'id' } }, { expr: { column: 'name' } }],
        where: {
          compare: '=',
          left: { column: 'grade' },
          right: { value: { var: 'input.grade' } },
        },
      },
      { input: { grade: 8 } },
      secrets,
      db.connector,
    )
    expect(rows).toEqual([{ id: 1, name: 'Asha' }])
    expect(db.calls[0]).toEqual({
      sql: 'SELECT "id", "name" FROM "students" WHERE "grade" = $1 LIMIT $2',
      params: [8, 1000],
      url: secrets.SCHOOL_DB,
    })
    expect(db.closed()).toBe(1)
  })

  it('refuses writes on read-only sources before connecting', async () => {
    const db = fakeDb()
    await expect(
      runQuery(
        source,
        {
          operation: 'delete',
          from: { table: 'students' },
          allowAllRows: true,
        },
        {},
        secrets,
        db.connector,
      ),
    ).rejects.toThrow(/read-only/)
    expect(db.calls).toHaveLength(0)
  })

  it('explains missing credentials and database errors, and still closes', async () => {
    await expect(
      runQuery(
        source,
        { operation: 'select', from: { table: 'students' } },
        {},
        {},
        fakeDb().connector,
      ),
    ).rejects.toThrow(/credential "SCHOOL_DB"/)
    const db = fakeDb([], 'permission denied for table students')
    await expect(
      runQuery(
        source,
        { operation: 'select', from: { table: 'students' } },
        {},
        secrets,
        db.connector,
      ),
    ).rejects.toThrow(/rejected the query: permission denied/)
    expect(db.closed()).toBe(1)
  })

  it('reads the schema as tables and columns', async () => {
    const db = fakeDb([
      { table_name: 'students', column_name: 'id' },
      { table_name: 'students', column_name: 'name' },
      { TABLE_NAME: 'houses', COLUMN_NAME: 'id' },
    ])
    expect(await readSchema(source, secrets, db.connector)).toEqual({
      students: ['id', 'name'],
      houses: ['id'],
    })
  })
})

describe('server flows with a query step', () => {
  it('runs the query and feeds the rows to the next step', async () => {
    const project = { ...createProject(), dataSources: [source] }
    const flow = { ...createFlow('Grade report'), runAt: 'server' as const }
    const query = createStep('query', 'q')
    query.dataSource = 'ds1'
    query.query = {
      operation: 'select',
      from: { table: 'students' },
      fields: [{ expr: { column: 'name' } }],
    }
    const names = createStep('compute', 'names')
    names.after = ['q']
    names.logic = { join: [{ pluck: [{ var: 'steps.q' }, 'name'] }, ', '] }
    flow.steps.push(query, names)
    project.flows.push(flow)
    const db = fakeDb([{ name: 'Asha' }, { name: 'Ravi' }])
    const store = new KvStore({
      get: async () => null,
      getWithMetadata: async () => ({ value: null, metadata: null }),
      put: async () => undefined,
      delete: async () => undefined,
      list: async () => ({ keys: [], list_complete: true }),
    })
    const result = await runServerFlow({
      project,
      flowId: flow.id,
      request: {},
      origin: 'https://site.test',
      secrets: new EnvSecrets({ APP_SECRET_SCHOOL_DB: secrets.SCHOOL_DB }),
      store,
      source: 'test',
      connector: db.connector,
    })
    expect(result.status).toBe('success')
    expect(result.output).toBe('Asha, Ravi')
  })
})

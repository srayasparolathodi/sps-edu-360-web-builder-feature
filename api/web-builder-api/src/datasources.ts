/**
 * Runs compiled queries against authors' own databases (PostgreSQL, MySQL).
 * Connection URLs come from credentials (OpenBao), never from the project.
 * Workers can't share TCP connections between requests, so each request
 * opens one connection, uses it, and closes it.
 */
import { Client as PgClient } from 'pg'
import { createConnection } from 'mysql2/promise'
import { DataSource } from '@spsedu360/engine/model'
import {
  CompiledQuery,
  QueryDef,
  SchemaMap,
  compileQuery,
} from '@spsedu360/engine/query'
import { StepError } from '@spsedu360/engine/resilience'

export interface SqlConnection {
  run(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>
  close(): Promise<void>
}

export type Connector = (
  source: DataSource,
  url: string,
) => Promise<SqlConnection>

const STATEMENT_TIMEOUT_MS = 15_000

/** Opens a real connection; replaced in tests. */
export const connect: Connector = async (source, url) => {
  if (!/^(postgres(ql)?|mysql):\/\//i.test(url))
    throw new StepError(
      `The credential "${source.credential}" must hold a connection URL like ${source.type === 'mysql' ? 'mysql://user:pass@host:3306/db' : 'postgresql://user:pass@host:5432/db'}.`,
      undefined,
      false,
    )
  if (source.type === 'postgres') {
    const client = new PgClient({
      connectionString: url,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      connectionTimeoutMillis: 8000,
    })
    await client.connect()
    return {
      run: async (sql, params) => (await client.query(sql, params)).rows,
      close: () => client.end(),
    }
  }
  // disableEval: Workers forbid code generation, which mysql2 otherwise uses for row parsing.
  const connection = await createConnection({
    uri: url,
    disableEval: true,
    connectTimeout: 8000,
  })
  return {
    run: async (sql, params) => {
      const [rows] = await connection.execute(
        { sql, timeout: STATEMENT_TIMEOUT_MS },
        params as never,
      )
      return Array.isArray(rows)
        ? (rows as Record<string, unknown>[])
        : [
            {
              affectedRows:
                (rows as { affectedRows?: number }).affectedRows ?? 0,
            },
          ]
    },
    close: () => connection.end(),
  }
}

function urlFor(source: DataSource, secrets: Record<string, string>): string {
  const url = secrets[source.credential]
  if (!url)
    throw new StepError(
      `The credential "${source.credential}" for "${source.name}" is missing. Add it under Data → Credentials.`,
      undefined,
      false,
    )
  return url
}

async function withConnection<T>(
  source: DataSource,
  secrets: Record<string, string>,
  connector: Connector,
  task: (connection: SqlConnection) => Promise<T>,
): Promise<T> {
  let connection: SqlConnection
  try {
    connection = await connector(source, urlFor(source, secrets))
  } catch (error) {
    if (error instanceof StepError) throw error
    throw new StepError(
      `Couldn't connect to "${source.name}": ${error instanceof Error ? error.message : 'unknown error'}.`,
    )
  }
  try {
    return await task(connection)
  } finally {
    await connection.close().catch(() => undefined)
  }
}

/** Compiles and runs one query; enforces read-only data sources. */
export async function runQuery(
  source: DataSource,
  query: QueryDef,
  data: unknown,
  secrets: Record<string, string>,
  connector: Connector = connect,
): Promise<Record<string, unknown>[]> {
  let compiled: CompiledQuery
  try {
    compiled = compileQuery(query, source.type, data, source.schema)
  } catch (error) {
    throw new StepError(
      error instanceof Error ? error.message : 'Invalid query.',
      undefined,
      false,
    )
  }
  if (source.readOnly && !compiled.readOnly)
    throw new StepError(
      `"${source.name}" is read-only, so rows can't be added, changed or deleted.`,
      undefined,
      false,
    )
  return withConnection(source, secrets, connector, async (connection) => {
    try {
      return await connection.run(compiled.sql, compiled.params)
    } catch (error) {
      // Database errors (constraint, syntax, permission) won't fix themselves on retry.
      throw new StepError(
        `The database rejected the query: ${error instanceof Error ? error.message : 'unknown error'}.`,
        400,
      )
    }
  })
}

/** Lists tables and their columns so the builder can offer them and check queries. */
export async function readSchema(
  source: DataSource,
  secrets: Record<string, string>,
  connector: Connector = connect,
): Promise<SchemaMap> {
  const sql =
    source.type === 'postgres'
      ? `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema NOT IN ('pg_catalog', 'information_schema') ORDER BY table_name, ordinal_position`
      : `SELECT table_name AS table_name, column_name AS column_name FROM information_schema.columns
       WHERE table_schema = DATABASE() ORDER BY table_name, ordinal_position`
  const rows = await withConnection(source, secrets, connector, (connection) =>
    connection.run(sql, []),
  )
  const schema: SchemaMap = {}
  for (const row of rows) {
    const table = String(row['table_name'] ?? row['TABLE_NAME'])
    const column = String(row['column_name'] ?? row['COLUMN_NAME'])
    if (Object.keys(schema).length >= 500 && !schema[table]) continue
    ;(schema[table] ??= []).push(column)
  }
  return schema
}

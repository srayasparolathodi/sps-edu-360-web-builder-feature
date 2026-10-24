import { describe, expect, it } from 'vitest'
import { QueryDef, compileQuery, previewSql, validateQuery } from './query'

const schema = {
  students: ['id', 'name', 'grade', 'house_id', 'fee', 'joined_at'],
  houses: ['id', 'name'],
  payments: ['id', 'student_id', 'amount'],
}

describe('compileQuery', () => {
  it('builds a filtered, sorted, paged select with parameters', () => {
    const def: QueryDef = {
      operation: 'select',
      from: { table: 'students', alias: 's' },
      fields: [
        { expr: { column: 's.name' } },
        { expr: { column: 'h.name' }, as: 'house' },
      ],
      joins: [
        {
          type: 'left',
          table: { table: 'houses', alias: 'h' },
          on: {
            compare: '=',
            left: { column: 's.house_id' },
            right: { column: 'h.id' },
          },
        },
      ],
      where: {
        and: [
          {
            compare: '>=',
            left: { column: 's.grade' },
            right: { value: { var: 'input.minGrade' } },
          },
          {
            compare: 'ilike',
            left: { column: 's.name' },
            right: { value: { cat: ['%', { var: 'input.q' }, '%'] } },
          },
        ],
      },
      orderBy: [
        { expr: { column: 's.name' }, direction: 'asc', nulls: 'last' },
      ],
      limit: { var: 'input.size' },
      offset: { '*': [{ var: 'input.page' }, { var: 'input.size' }] },
    }
    const data = { input: { minGrade: 6, q: 'as', page: 2, size: 20 } }
    const pg = compileQuery(def, 'postgres', data, schema)
    expect(pg.sql).toBe(
      'SELECT "s"."name", "h"."name" AS "house" FROM "students" AS "s" LEFT JOIN "houses" AS "h" ON "s"."house_id" = "h"."id" WHERE ("s"."grade" >= $1 AND "s"."name" ILIKE $2) ORDER BY "s"."name" ASC NULLS LAST LIMIT $3 OFFSET $4',
    )
    expect(pg.params).toEqual([6, '%as%', 20, 40])
    const my = compileQuery(def, 'mysql', data, schema)
    expect(my.sql).toContain('LOWER(`s`.`name`) LIKE LOWER(?)')
    expect(my.sql).toContain('`s`.`name` IS NULL ASC, `s`.`name` ASC')
    expect(my.params).toEqual([6, '%as%', 20, 40])
  })

  it('skips optional filters whose condition is false', () => {
    const def: QueryDef = {
      operation: 'select',
      from: { table: 'students' },
      where: {
        and: [
          {
            when: { '!!': [{ var: 'input.grade' }] },
            then: {
              compare: '=',
              left: { column: 'grade' },
              right: { value: { var: 'input.grade' } },
            },
          },
          {
            when: { '!!': [{ var: 'input.q' }] },
            then: {
              compare: 'like',
              left: { column: 'name' },
              right: { value: { var: 'input.q' } },
            },
          },
        ],
      },
    }
    expect(compileQuery(def, 'postgres', { input: {} }).sql).toBe(
      'SELECT * FROM "students" LIMIT $1',
    )
    const one = compileQuery(def, 'postgres', { input: { grade: 8 } })
    expect(one.sql).toBe('SELECT * FROM "students" WHERE "grade" = $1 LIMIT $2')
    expect(one.params).toEqual([8, 1000])
  })

  it('supports aggregates, group by, having, case, subqueries and in-lists', () => {
    const def: QueryDef = {
      operation: 'select',
      from: { table: 'students', alias: 's' },
      fields: [
        { expr: { column: 's.grade' } },
        { expr: { fn: 'count' }, as: 'total' },
        { expr: { fn: 'avg', args: [{ column: 's.fee' }] }, as: 'avg_fee' },
        {
          expr: {
            case: [
              {
                when: {
                  compare: '>',
                  left: { fn: 'count' },
                  right: { value: 30 },
                },
                then: { value: 'large' },
              },
            ],
            else: { value: 'small' },
          },
          as: 'size',
        },
      ],
      where: {
        and: [
          { in: { column: 's.house_id' }, list: { var: 'input.houses' } },
          {
            exists: {
              operation: 'select',
              from: { table: 'payments', alias: 'p' },
              where: {
                compare: '=',
                left: { column: 'p.student_id' },
                right: { column: 's.id' },
              },
            },
          },
        ],
      },
      groupBy: [{ column: 's.grade' }],
      having: { compare: '>=', left: { fn: 'count' }, right: { value: 5 } },
    }
    const compiled = compileQuery(
      def,
      'postgres',
      { input: { houses: [1, 2] } },
      schema,
    )
    expect(compiled.sql).toBe(
      'SELECT "s"."grade", COUNT(*) AS "total", AVG("s"."fee") AS "avg_fee", CASE WHEN COUNT(*) > $1 THEN $2 ELSE $3 END AS "size" FROM "students" AS "s" WHERE ("s"."house_id" IN ($4, $5) AND EXISTS (SELECT * FROM "payments" AS "p" WHERE "p"."student_id" = "s"."id")) GROUP BY "s"."grade" HAVING COUNT(*) >= $6 LIMIT $7',
    )
    expect(compiled.params).toEqual([30, 'large', 'small', 1, 2, 5, 1000])
  })

  it('keeps MySQL parameters in SQL text order across fields, joins and filters', () => {
    const def: QueryDef = {
      operation: 'select',
      from: { table: 'students', alias: 's' },
      fields: [
        {
          expr: {
            case: [
              {
                when: {
                  compare: '>',
                  left: { column: 's.fee' },
                  right: { value: 'F1' },
                },
                then: { value: 'F2' },
              },
            ],
          },
          as: 'band',
        },
      ],
      joins: [
        {
          type: 'inner',
          table: { table: 'houses', alias: 'h' },
          on: {
            and: [
              {
                compare: '=',
                left: { column: 'h.id' },
                right: { column: 's.house_id' },
              },
              {
                compare: '!=',
                left: { column: 'h.name' },
                right: { value: 'J1' },
              },
            ],
          },
        },
      ],
      where: {
        compare: '=',
        left: { column: 's.grade' },
        right: { value: 'W1' },
      },
      having: { compare: '>', left: { fn: 'count' }, right: { value: 'H1' } },
      groupBy: [{ column: 's.grade' }],
      limit: 5,
    }
    const compiled = compileQuery(def, 'mysql', {}, schema)
    const order = ['F1', 'F2', 'J1', 'W1', 'H1', 5]
    expect(compiled.params).toEqual(order)
    // Each "?" in the text lines up with the parameter at the same position.
    const markers = ['F1', 'F2', 'J1', 'W1', 'H1']
    const sqlWithValues = previewSql(compiled)
    let last = -1
    for (const marker of markers) {
      const at = sqlWithValues.indexOf(`'${marker}'`)
      expect(at).toBeGreaterThan(last)
      last = at
    }
  })

  it('treats an empty in-list as matching nothing', () => {
    const def: QueryDef = {
      operation: 'select',
      from: { table: 'students' },
      where: { in: { column: 'id' }, list: { var: 'input.ids' } },
    }
    expect(compileQuery(def, 'postgres', { input: { ids: [] } }).sql).toContain(
      'WHERE 1 = 0',
    )
  })

  it('compiles inserts, updates and deletes, and refuses unfiltered changes', () => {
    const insert = compileQuery(
      {
        operation: 'insert',
        from: { table: 'students' },
        rows: { var: 'input.rows' },
        returning: ['id'],
      },
      'postgres',
      {
        input: {
          rows: [
            { name: 'Asha', grade: 8 },
            { name: 'Ravi', grade: 9 },
          ],
        },
      },
      schema,
    )
    expect(insert.sql).toBe(
      'INSERT INTO "students" ("name", "grade") VALUES ($1, $2), ($3, $4) RETURNING "id"',
    )
    expect(insert.readOnly).toBe(false)

    const update = compileQuery(
      {
        operation: 'update',
        from: { table: 'students' },
        set: [
          {
            column: 'grade',
            value: { op: '+', left: { column: 'grade' }, right: { value: 1 } },
          },
        ],
        where: {
          compare: '=',
          left: { column: 'id' },
          right: { value: { var: 'input.id' } },
        },
      },
      'mysql',
      { input: { id: 7 } },
      schema,
    )
    expect(update.sql).toBe(
      'UPDATE `students` SET `grade` = (`grade` + ?) WHERE `id` = ?',
    )
    expect(update.params).toEqual([1, 7])

    expect(() =>
      compileQuery(
        { operation: 'delete', from: { table: 'students' } },
        'postgres',
      ),
    ).toThrow(/Add a filter/)
    expect(
      compileQuery(
        {
          operation: 'delete',
          from: { table: 'students' },
          allowAllRows: true,
        },
        'postgres',
      ).sql,
    ).toBe('DELETE FROM "students"')
  })

  it('rejects unsafe identifiers, unknown columns and objects as values', () => {
    expect(() =>
      compileQuery(
        { operation: 'select', from: { table: 'students; drop table x' } },
        'postgres',
      ),
    ).toThrow(/not a valid table/)
    expect(() =>
      compileQuery(
        {
          operation: 'select',
          from: { table: 'students' },
          fields: [{ expr: { column: 'password' } }],
        },
        'postgres',
        {},
        schema,
      ),
    ).toThrow(/does not exist/)
    expect(() =>
      compileQuery(
        { operation: 'select', from: { table: 'secrets' } },
        'postgres',
        {},
        schema,
      ),
    ).toThrow(/does not exist/)
    expect(() =>
      compileQuery(
        {
          operation: 'select',
          from: { table: 'students' },
          where: {
            compare: '=',
            left: { column: 'id' },
            right: { value: { preserve: { a: 1 } } },
          },
        },
        'postgres',
      ),
    ).toThrow(/not a list or object/)
    expect(() =>
      compileQuery(
        {
          operation: 'select',
          from: { table: 'students' },
          fields: [{ expr: { fn: 'pg_sleep' as never, args: [] } }],
        },
        'postgres',
      ),
    ).toThrow(/not an allowed function/)
  })

  it('caps limits and previews readable SQL', () => {
    const compiled = compileQuery(
      {
        operation: 'select',
        from: { table: 'students' },
        where: {
          compare: '=',
          left: { column: 'name' },
          right: { value: "O'Brien" },
        },
        limit: 999999,
      },
      'postgres',
    )
    expect(compiled.params.at(-1)).toBe(10000)
    expect(previewSql(compiled)).toBe(
      `SELECT * FROM "students" WHERE "name" = 'O''Brien' LIMIT 10000`,
    )
  })

  it('supports CTEs, window functions and sorting by result names', () => {
    const def: QueryDef = {
      operation: 'select',
      with: [
        {
          name: 'paid',
          query: {
            operation: 'select',
            from: { table: 'payments' },
            fields: [
              { expr: { column: 'student_id' } },
              {
                expr: { fn: 'sum', args: [{ column: 'amount' }] },
                as: 'total',
              },
            ],
            groupBy: [{ column: 'student_id' }],
            where: {
              compare: '>',
              left: { column: 'amount' },
              right: { value: { var: 'input.min' } },
            },
          },
        },
      ],
      from: { table: 'students', alias: 's' },
      joins: [
        {
          type: 'inner',
          table: { table: 'paid', alias: 'p' },
          on: {
            compare: '=',
            left: { column: 'p.student_id' },
            right: { column: 's.id' },
          },
        },
      ],
      fields: [
        { expr: { column: 's.name' } },
        { expr: { column: 'p.total' } },
        {
          expr: {
            window: 'rank',
            partitionBy: [{ column: 's.grade' }],
            orderBy: [{ expr: { column: 'p.total' }, direction: 'desc' }],
          },
          as: 'rank_in_grade',
        },
      ],
      orderBy: [{ expr: { column: 'rank_in_grade' } }],
      limit: { var: 'input.n' },
    }
    const pg = compileQuery(
      def,
      'postgres',
      { input: { min: 100, n: 10 } },
      schema,
    )
    expect(pg.sql).toBe(
      'WITH "paid" AS (SELECT "student_id", SUM("amount") AS "total" FROM "payments" WHERE "amount" > $1 GROUP BY "student_id") SELECT "s"."name", "p"."total", RANK() OVER (PARTITION BY "s"."grade" ORDER BY "p"."total" DESC) AS "rank_in_grade" FROM "students" AS "s" INNER JOIN "paid" AS "p" ON "p"."student_id" = "s"."id" ORDER BY "rank_in_grade" ASC LIMIT $2',
    )
    expect(pg.params).toEqual([100, 10])
    // A misspelt real column is still caught even with a CTE around.
    expect(() =>
      compileQuery(
        { ...def, fields: [{ expr: { column: 's.nmae' } }] },
        'postgres',
        { input: { min: 1 } },
        schema,
      ),
    ).toThrow(/does not exist/)
  })

  it('uses sub-queries as tables and combines results with union', () => {
    const def: QueryDef = {
      operation: 'select',
      from: {
        alias: 'top',
        subquery: {
          operation: 'select',
          from: { table: 'students' },
          fields: [{ expr: { column: 'name' } }, { expr: { column: 'fee' } }],
          where: {
            compare: '>',
            left: { column: 'fee' },
            right: { value: 'A' },
          },
        },
      },
      fields: [{ expr: { column: 'top.name' } }],
      union: [
        {
          type: 'unionAll',
          query: {
            operation: 'select',
            from: { table: 'houses' },
            fields: [{ expr: { column: 'name' } }],
            where: {
              compare: '=',
              left: { column: 'id' },
              right: { value: 'B' },
            },
          },
        },
      ],
      orderBy: [{ expr: { column: 'name' } }],
      limit: 3,
    }
    const my = compileQuery(def, 'mysql', {}, schema)
    expect(my.sql).toBe(
      '(SELECT `top`.`name` FROM (SELECT `name`, `fee` FROM `students` WHERE `fee` > ?) AS `top`) UNION ALL (SELECT `name` FROM `houses` WHERE `id` = ?) ORDER BY `name` ASC LIMIT ?',
    )
    expect(my.params).toEqual(['A', 'B', 3])
  })

  it('casts, uses date and text helpers, and cross joins', () => {
    const def: QueryDef = {
      operation: 'select',
      from: { table: 'students', alias: 's' },
      joins: [{ type: 'cross', table: { table: 'houses', alias: 'h' } }],
      fields: [
        { expr: { cast: { column: 's.grade' }, to: 'text' }, as: 'grade_text' },
        {
          expr: {
            fn: 'daysBetween',
            args: [{ column: 's.joined_at' }, { fn: 'now' }],
          },
          as: 'days',
        },
        {
          expr: {
            fn: 'addDays',
            args: [{ column: 's.joined_at' }, { value: 30 }],
          },
          as: 'due',
        },
        {
          expr: {
            fn: 'substring',
            args: [{ column: 's.name' }, { value: 1 }, { value: 3 }],
          },
          as: 'short',
        },
      ],
    }
    expect(compileQuery(def, 'postgres', {}, schema).sql).toBe(
      'SELECT CAST("s"."grade" AS TEXT) AS "grade_text", ((NOW())::date - ("s"."joined_at")::date) AS "days", ("s"."joined_at" + ($1) * INTERVAL \'1 day\') AS "due", SUBSTRING("s"."name", $2, $3) AS "short" FROM "students" AS "s" CROSS JOIN "houses" AS "h" LIMIT $4',
    )
    expect(compileQuery(def, 'mysql', {}, schema).sql).toContain(
      'DATEDIFF(NOW(), `s`.`joined_at`) AS `days`, DATE_ADD(`s`.`joined_at`, INTERVAL ? DAY)',
    )
  })

  it('upserts on both dialects and inserts from a select', () => {
    const upsert: QueryDef = {
      operation: 'upsert',
      from: { table: 'students' },
      set: [
        { column: 'id', value: { value: 7 } },
        { column: 'name', value: { value: 'Asha' } },
        { column: 'grade', value: { value: 9 } },
      ],
      conflict: ['id'],
    }
    expect(compileQuery(upsert, 'postgres', {}, schema).sql).toBe(
      'INSERT INTO "students" ("id", "name", "grade") VALUES ($1, $2, $3) ON CONFLICT ("id") DO UPDATE SET "name" = EXCLUDED."name", "grade" = EXCLUDED."grade"',
    )
    expect(compileQuery(upsert, 'mysql', {}, schema).sql).toBe(
      'INSERT INTO `students` (`id`, `name`, `grade`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `name` = VALUES(`name`), `grade` = VALUES(`grade`)',
    )
    const copy: QueryDef = {
      operation: 'insert',
      from: { table: 'houses' },
      columns: ['name'],
      select: {
        operation: 'select',
        from: { table: 'students' },
        fields: [{ expr: { column: 'name' } }],
        where: {
          compare: '=',
          left: { column: 'grade' },
          right: { value: 12 },
        },
      },
    }
    const compiled = compileQuery(copy, 'postgres', {}, schema)
    expect(compiled.sql).toBe(
      'INSERT INTO "houses" ("name") SELECT "name" FROM "students" WHERE "grade" = $1',
    )
    expect(compiled.readOnly).toBe(false)
  })

  it('checks window functions and correlated sub-queries', () => {
    expect(() =>
      compileQuery(
        {
          operation: 'select',
          from: { table: 'students' },
          fields: [{ expr: { window: 'row_number' } }],
        },
        'postgres',
        {},
        schema,
      ),
    ).toThrow(/needs a sort order/)
    // A sub-query can refer to the outer table (correlated) and to its own.
    const correlated: QueryDef = {
      operation: 'select',
      from: { table: 'students', alias: 's' },
      fields: [
        { expr: { column: 's.name' } },
        {
          expr: {
            subquery: {
              operation: 'select',
              from: { table: 'payments', alias: 'p' },
              fields: [{ expr: { fn: 'sum', args: [{ column: 'p.amount' }] } }],
              where: {
                compare: '=',
                left: { column: 'p.student_id' },
                right: { column: 's.id' },
              },
            },
          },
          as: 'paid',
        },
      ],
      where: {
        in: { column: 's.id' },
        negate: true,
        subquery: {
          operation: 'select',
          from: { table: 'payments' },
          fields: [{ expr: { column: 'student_id' } }],
        },
      },
    }
    expect(compileQuery(correlated, 'postgres', {}, schema).sql).toBe(
      'SELECT "s"."name", (SELECT SUM("p"."amount") FROM "payments" AS "p" WHERE "p"."student_id" = "s"."id") AS "paid" FROM "students" AS "s" WHERE "s"."id" NOT IN (SELECT "student_id" FROM "payments") LIMIT $1',
    )
  })

  it('validates shape at design time without sample data', () => {
    expect(
      validateQuery(
        {
          operation: 'select',
          from: { table: 'students' },
          limit: { var: 'input.size' },
        },
        'postgres',
        schema,
      ),
    ).toEqual([])
    expect(
      validateQuery(
        { operation: 'select', from: { table: 'nope' } },
        'postgres',
        schema,
      )[0],
    ).toMatch(/does not exist/)
  })
})

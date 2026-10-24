import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  LogicError,
  describe as describeLogic,
  evaluate,
  setCompileMode,
  validateLogic,
} from './logic'

// Browsers compile logic; Cloudflare Workers must interpret it. Run every case both ways.
for (const compile of [true, false])
  describe(`evaluate (${compile ? 'compiled' : 'interpreted, as on Workers'})`, () => {
    beforeAll(() => setCompileMode(compile))
    afterAll(() => setCompileMode(true))
    it('runs built-in operators with variables', () => {
      expect(
        evaluate({ '+': [{ var: 'vars.a' }, 2] }, { vars: { a: 3 } }),
      ).toBe(5)
      expect(
        evaluate(
          { if: [{ '>': [{ var: 'x' }, 10] }, 'big', 'small'] },
          { x: 12 },
        ),
      ).toBe('big')
      expect(evaluate({ map: [[1, 2, 3], { '*': [{ var: '' }, 2] }] })).toEqual(
        [2, 4, 6],
      )
    })

    it('returns plain values unchanged', () => {
      expect(evaluate('hello')).toBe('hello')
      expect(evaluate(42)).toBe(42)
      expect(evaluate({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 })
    })

    it('supports math, text and list helpers', () => {
      expect(evaluate({ round: [3.14159, 2] })).toBe(3.14)
      expect(evaluate({ sum: [[1, '2', 3]] })).toBe(6)
      expect(evaluate({ avg: [[2, 4]] })).toBe(3)
      expect(evaluate({ toNumber: ['1,200'] })).toBe(1200)
      expect(
        evaluate(
          { format: ['Hi {user.name}', { var: '' }] },
          { user: { name: 'Asha' } },
        ),
      ).toBe('Hi Asha')
      expect(evaluate({ upper: ['abc'] })).toBe('ABC')
      expect(evaluate({ replace: ['a-b-c', '-', '+'] })).toBe('a+b+c')
      expect(evaluate({ sort: [[{ n: 2 }, { n: 1 }], 'n'] })).toEqual([
        { n: 1 },
        { n: 2 },
      ])
      expect(evaluate({ sumBy: [[{ p: 2 }, { p: 3 }], 'p'] })).toBe(5)
      expect(
        evaluate({ whereEquals: [[{ c: 'a' }, { c: 'b' }], 'c', 'b'] }),
      ).toEqual([{ c: 'b' }])
      expect(evaluate({ unique: [[1, 1, 2]] })).toEqual([1, 2])
      expect(evaluate({ object: ['a', 1, 'b', { '+': [1, 1] }] })).toEqual({
        a: 1,
        b: 2,
      })
      expect(evaluate({ setField: [{ a: { b: 1 } }, 'a.c', 2] })).toEqual({
        a: { b: 1, c: 2 },
      })
      expect(evaluate({ isEmail: ['a@b.co'] })).toBe(true)
    })

    it('handles dates', () => {
      expect(
        evaluate({ dateAdd: ['2026-01-31T00:00:00.000Z', 1, 'days'] }),
      ).toBe('2026-02-01T00:00:00.000Z')
      expect(evaluate({ dateDiff: ['2026-01-01', '2026-01-11', 'days'] })).toBe(
        10,
      )
      expect(evaluate({ formatDate: ['2026-03-05T00:00:00Z', 'date'] })).toBe(
        '2026-03-05',
      )
      expect(() => evaluate({ dateAdd: ['not a date', 1, 'days'] })).toThrow(
        LogicError,
      )
    })

    it('treats non-operator objects as data and evaluates logic inside them', () => {
      expect(evaluate({ nope: [1] })).toEqual({ nope: [1] })
      expect(
        evaluate(
          { Authorization: { cat: ['Bearer ', { var: 't' }] } },
          { t: 'x' },
        ),
      ).toEqual({ Authorization: 'Bearer x' })
      expect(evaluate({ a: { '+': [1, 2] }, b: 'text' })).toEqual({
        a: 3,
        b: 'text',
      })
    })

    it('rejects prototype access with friendly errors', () => {
      expect(() => evaluate({ var: 'a.__proto__' })).toThrow(/not allowed/)
      expect(validateLogic({ var: 'constructor' })).toHaveLength(1)
      expect(evaluate({ getField: [{ var: '' }, 'constructor'] }, {})).toBe(
        null,
      )
    })

    it('guards regular expressions', () => {
      expect(evaluate({ matches: ['abc123', '^[a-z]+\\d+$'] })).toBe(true)
      expect(() => evaluate({ matches: ['aaaa', '(a+)+$'] })).toThrow(
        /too complex/,
      )
    })

    it('describes logic in plain language', () => {
      expect(describeLogic({ '*': [{ var: 'price' }, { var: 'qty' }] })).toBe(
        '(price × qty)',
      )
    })
  })

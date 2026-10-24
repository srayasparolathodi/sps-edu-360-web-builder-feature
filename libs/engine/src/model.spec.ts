import { describe, expect, it } from 'vitest'
import {
  blockCss,
  buildPath,
  createBlock,
  createProject,
  duplicateBlock,
  exportBlock,
  matchPath,
  moveBlock,
  parseProject,
  pathProblem,
  resolvePage,
  safeStyle,
  safeUrl,
} from './model'

describe('blocks', () => {
  it('nested moves preserve children and reject cycles', () => {
    const parent = createBlock('container')
    const child = createBlock('card')
    parent.children.push(child)
    const blocks = [parent, createBlock('text')]
    expect(moveBlock(blocks, parent.id, child.id, 0)).toBe(false)
    expect(moveBlock(blocks, blocks[1].id, child.id, 0)).toBe(true)
    expect(child.children[0].type).toBe('text')
    expect(blocks).toHaveLength(1)
    expect(moveBlock(blocks, child.id, 'root', 0)).toBe(true)
    expect(blocks[0].id).toBe(child.id)
  })

  it('duplicates have independent identifiers and style maps', () => {
    const parent = createBlock('section')
    parent.children.push(createBlock('heading'))
    const copy = duplicateBlock(parent)
    expect(copy.id).not.toBe(parent.id)
    expect(copy.children[0].id).not.toBe(parent.children[0].id)
    copy.styles['color'] = 'red'
    expect(parent.styles).toEqual({})
  })

  it('export escapes markup and blocks script URLs and CSS injection', () => {
    const link = createBlock('link')
    link.text = '<script>alert(1)</script>'
    link.url = 'javascript:alert(1)'
    expect(safeUrl(link.url)).toBe('')
    expect(exportBlock(link)).toMatch(/&lt;script&gt;/)
    expect(safeStyle('color', 'url(https://bad.example)')).toBe(false)
    expect(safeStyle('position', 'fixed')).toBe(false)
    expect(safeStyle('padding', '16px')).toBe(true)
  })

  it('responsive overrides remain scoped', () => {
    const block = createBlock('text')
    block.mobileStyles['padding'] = '8px'
    expect(blockCss(block)).toMatch(/@media\(max-width:600px\)/)
    expect(blockCss(block)).toMatch(
      new RegExp(`element-${block.id}\{padding:8px\}`),
    )
  })
})

describe('projects', () => {
  it('round-trips and rejects injected styles', () => {
    const project = createProject()
    project.pages[0].blocks.push(createBlock('heading'))
    expect(parseProject(JSON.stringify(project))).toEqual(project)
    project.pages[0].blocks[0].styles['color'] = 'red; } body { display:none'
    expect(() => parseProject(JSON.stringify(project))).toThrow()
  })

  it('migrates version 1 projects', () => {
    const v1 = {
      version: 1,
      name: 'Old',
      dark: false,
      pages: [
        { id: 'p1', name: 'Home', slug: 'home', blocks: [] },
        { id: 'p2', name: 'About', slug: 'about', blocks: [] },
      ],
    }
    const project = parseProject(JSON.stringify(v1))
    expect(project.version).toBe(2)
    expect(project.pages.map((page) => page.path)).toEqual(['', 'about'])
    expect(project.flows).toEqual([])
  })

  it('validates block logic and flow references', () => {
    const project = createProject()
    const block = createBlock('text')
    block.logic = { text: { var: 'a.__proto__' } }
    project.pages[0].blocks.push(block)
    expect(() => parseProject(JSON.stringify(project))).toThrow(/not allowed/)
    block.logic = {}
    block.source = 'missing-flow'
    expect(() => parseProject(JSON.stringify(project))).toThrow(
      /no longer exists/,
    )
  })
})

describe('paths', () => {
  it('matches multi-part paths with variables', () => {
    expect(
      matchPath('students/:id/reports/:term', '/students/42/reports/2026-t1'),
    ).toEqual({ id: '42', term: '2026-t1' })
    expect(matchPath('students/:id', 'students/42/extra')).toBeNull()
    expect(matchPath('', '/')).toEqual({})
    expect(
      buildPath('students/:id/reports/:term', { id: 'a b', term: 't1' }),
    ).toBe('students/a%20b/reports/t1')
  })

  it('prefers fixed paths over variables', () => {
    const project = createProject()
    project.pages.push({
      id: 'b',
      name: 'Student',
      path: 'students/:id',
      blocks: [],
    })
    project.pages.push({
      id: 'c',
      name: 'New',
      path: 'students/new',
      blocks: [],
    })
    expect(resolvePage(project, 'students/new')?.page.id).toBe('c')
    expect(resolvePage(project, 'students/7')?.params).toEqual({ id: '7' })
  })

  it('explains invalid patterns', () => {
    expect(pathProblem('Students/:id')).toMatch(/not valid/)
    expect(pathProblem('a/:id/b/:id')).toMatch(/different name/)
    expect(pathProblem('a/:id/b')).toBe('')
  })
})

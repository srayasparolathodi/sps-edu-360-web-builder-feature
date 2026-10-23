import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  createBlock,
  createProject,
  moveBlock,
  duplicateBlock,
  parseProject,
  safeUrl,
  safeStyle,
  exportBlock,
  blockCss,
} from './builder-model.ts'

test('nested moves preserve children and reject cycles', () => {
  const parent = createBlock('container')
  const child = createBlock('card')
  parent.children.push(child)
  const blocks = [parent, createBlock('text')]
  assert.equal(moveBlock(blocks, parent.id, child.id, 0), false)
  assert.equal(moveBlock(blocks, blocks[1].id, child.id, 0), true)
  assert.equal(child.children[0].type, 'text')
  assert.equal(blocks.length, 1)
  assert.equal(moveBlock(blocks, child.id, 'root', 0), true)
  assert.equal(blocks[0].id, child.id)
})

test('duplicates have independent identifiers and style maps', () => {
  const parent = createBlock('section')
  parent.children.push(createBlock('heading'))
  const copy = duplicateBlock(parent)
  assert.notEqual(copy.id, parent.id)
  assert.notEqual(copy.children[0].id, parent.children[0].id)
  copy.styles.color = 'red'
  assert.deepEqual(parent.styles, {})
})

test('project import validates nested content and rejects injected styles', () => {
  const project = createProject()
  project.pages[0].blocks.push(createBlock('heading'))
  assert.deepEqual(parseProject(JSON.stringify(project)), project)
  project.pages[0].blocks[0].styles.color = 'red; } body { display:none'
  assert.throws(() => parseProject(JSON.stringify(project)))
})

test('export escapes markup and blocks script URLs and CSS injection', () => {
  const link = createBlock('link')
  link.text = '<script>alert(1)</script>'
  link.url = 'javascript:alert(1)'
  assert.equal(safeUrl(link.url), '')
  assert.match(exportBlock(link), /&lt;script&gt;/)
  assert.equal(safeStyle('color', 'url(https://bad.example)'), false)
  assert.equal(safeStyle('position', 'fixed'), false)
  assert.equal(safeStyle('padding', '16px'), true)
})

test('unconfigured blocks inherit theme and responsive overrides remain scoped', () => {
  const block = createBlock('text')
  assert.deepEqual(block.styles, {})
  block.mobileStyles.padding = '8px'
  assert.match(blockCss(block), /@media\(max-width:600px\)/)
  assert.match(
    blockCss(block),
    new RegExp(`element-${block.id}\\{padding:8px\\}`),
  )
})

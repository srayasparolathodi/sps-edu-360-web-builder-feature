import { describe, expect, it } from 'vitest'
import { BLOCKS, Block, createProject } from './model'
import { STEP_TYPES } from './flow'
import {
  EXAMPLE_APP,
  ImportError,
  aiPrompt,
  extractJson,
  importJson,
} from './ai-import'

const all = (blocks: Block[]): Block[] =>
  blocks.flatMap((block) => [block, ...all(block.children)])

describe('importJson', () => {
  it('imports the example from the prompt exactly, with nothing to correct', () => {
    const { project, warnings, summary } = importJson(EXAMPLE_APP)
    expect(warnings).toEqual([])
    expect(summary).toMatchObject({ pages: 3, components: 1, flows: 3 })
    expect(project.pages.map((page) => [page.id, page.path])).toEqual([
      ['home', ''],
      ['admissions', 'admissions'],
      ['teacher', 'teachers/:teacherId'],
    ])
    // References kept: component on both pages, flows on events and data.
    const home = all(project.pages[0].blocks)
    expect(home.find((block) => block.type === 'component')?.componentId).toBe(
      'site-header',
    )
    expect(home.find((block) => block.type === 'repeater')?.source).toBe(
      'load-teachers',
    )
    expect(
      all(project.pages[1].blocks).find((block) => block.type === 'form')?.on,
    ).toEqual({ submit: 'submit-application' })
    // Variables that inputs save into are declared.
    expect(project.variables.map((variable) => variable.name).sort()).toEqual([
      'grade',
      'parentEmail',
      'studentName',
    ])
  })

  it('cleans up a typical assistant answer', () => {
    const answer = `Sure! Here is your app:
\`\`\`json
{
  "name": "Riverside",
  "pages": [
    { "name": "Home", "blocks": [
      { "type": "navbar", "items": ["Home|/", "Contact|/contact"] },
      { "type": "h1", "content": "Welcome", },
      { "type": "img", "src": "https://example.com/a.jpg" },
      { "type": "paragraph", "text": "Hello", "children": [ { "type": "button", "text": "Go" } ] },
      { "type": "sparkles", "text": "?" },
      { "type": "section", "style": { "paddingTop": 24, "backgroundColor": "#fff", "position": "absolute" },
        "children": [ { "type": "input", "label": "Name", "bind": "session.visitorName" } ] },
      { "type": "repeater", "source": "Load news", "children": [ { "type": "text", "logic": { "text": { "var": "item.title" } } } ] },
      { "type": "button", "text": "Refresh", "on": { "click": "load_news" } }
    ]},
    { "name": "Contact", "path": "/Contact Us" }
  ],
  "flows": [
    { "id": "load_news", "name": "Load news", "trigger": "pageLoad", "steps": [
      { "id": "fetch_news", "type": "api", "url": "https://example.com/news" },
      { "id": "top", "type": "calculate", "after": ["fetch_news"], "logic": { "slice": [ { "var": "steps.fetch_news" }, 0, 5 ] } }
    ]}
  ],
}
\`\`\`
Let me know if you need changes.`
    const { project, warnings } = importJson(answer)
    const home = all(project.pages[0].blocks)
    expect(home.map((block) => block.type)).toEqual([
      'navigation',
      'heading',
      'image',
      'text',
      'button',
      'text',
      'section',
      'input',
      'repeater',
      'text',
      'button',
    ])
    expect(home[0].options).toBe('Home|/\nContact|/contact')
    expect(home[1]).toMatchObject({ level: '1', text: 'Welcome' })
    expect(home[2].url).toBe('https://example.com/a.jpg')
    // camelCase becomes CSS names, numbers get px, unsupported properties are dropped.
    expect(home[6].styles).toEqual({
      padding: '24px 0 0 0',
      'background-color': '#fff',
    })
    expect(home[7].bind).toEqual({ scope: 'session', name: 'visitorName' })
    expect(project.pages[1].path).toBe('contact-us')
    // Flow referenced by name and by an id that had to change; step references follow the new ids.
    const flow = project.flows[0]
    expect(home[8].source).toBe(flow.id)
    expect(home[10].on?.click).toBe(flow.id)
    const [fetch, top] = flow.steps
    expect(fetch.type).toBe('http')
    expect(top.after).toEqual([fetch.id])
    expect(JSON.stringify(top.logic)).toContain(`steps.${fetch.id}`)
    expect(project.variables).toContainEqual(
      expect.objectContaining({ scope: 'session', name: 'visitorName' }),
    )
    expect(warnings.some((warning) => /sparkles/.test(warning))).toBe(true)
    expect(warnings.some((warning) => /position/.test(warning))).toBe(true)
    expect(warnings.some((warning) => /placed after them/.test(warning))).toBe(
      true,
    )
  })

  it('accepts a single page or a bare list of blocks', () => {
    expect(
      importJson({
        name: 'About',
        path: 'about',
        blocks: [{ type: 'heading', text: 'About us' }],
      }).project.pages[0].name,
    ).toBe('About')
    expect(
      importJson('[{"type":"text","text":"Hi"}]').project.pages[0].blocks[0]
        .text,
    ).toBe('Hi')
  })

  it('adds pages to an existing app without clashing, and can use its flows and components', () => {
    const existing = createProject('School')
    existing.components = [
      { id: 'site-header', name: 'Site header', blocks: [] },
    ]
    existing.flows.push({
      ...EXAMPLE_APP.flows[0],
      id: 'load-teachers',
      pageIds: [],
      emptyMessage: '',
      positions: {},
      description: '',
      runAt: 'client',
      mode: 'parallel',
      trigger: 'manual',
      steps: [],
    } as never)
    const { project } = importJson(
      {
        pages: [
          {
            id: existing.pages[0].id,
            name: 'Home',
            path: '',
            blocks: [
              { type: 'component', componentId: 'Site header' },
              { type: 'repeater', source: 'load-teachers' },
            ],
          },
        ],
      },
      { existing },
    )
    expect(project.pages).toHaveLength(2)
    const added = project.pages[1]
    expect(added.id).not.toBe(existing.pages[0].id)
    expect(added.name).toBe('Home 2')
    expect(added.path).not.toBe('')
    expect(added.blocks[0].componentId).toBe('site-header')
    expect(added.blocks[1].source).toBe('load-teachers')
  })

  it('explains what is wrong when the answer cannot be used', () => {
    expect(() => extractJson('')).toThrow(/Paste the JSON/)
    expect(() => extractJson('I cannot help with that.')).toThrow(
      /No JSON found/,
    )
    expect(() => extractJson('{"pages": [')).toThrow(/cut off/)
    expect(() => importJson({ name: 'Empty' })).toThrow(ImportError)
    expect(() => importJson({ name: 'Empty' })).toThrow(/no pages/)
  })
})

describe('aiPrompt', () => {
  it('describes every block and step type and includes the requirements', () => {
    const prompt = aiPrompt({
      requirements: 'A school website with admissions',
    })
    for (const block of BLOCKS) expect(prompt).toContain(`- ${block.type}`)
    for (const step of STEP_TYPES) expect(prompt).toContain(`- ${step.type}:`)
    expect(prompt).toContain('A school website with admissions')
    expect(prompt).toContain('ONE JSON object')
  })

  it('lists the existing app when adding pages to it', () => {
    const existing = createProject('Riverside')
    const prompt = aiPrompt({ existing })
    expect(prompt).toContain('Add to this existing app')
    expect(prompt).toContain(`${existing.pages[0].id}, Home, /`)
  })
})

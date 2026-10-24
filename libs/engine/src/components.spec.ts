import { describe, expect, it } from 'vitest'
import {
  ComponentDef,
  OUTPUT_PREFIX,
  createBlock,
  createProject,
  parseProject,
} from './model'
import { expandProject } from './publishing'
import { createFlow } from './flow'
import { importJson } from './ai-import'

function cardApp() {
  const project = createProject('Cards')
  const open = createFlow('Open student')
  project.flows.push(open)
  const card: ComponentDef = {
    id: 'student-card',
    name: 'Student card',
    inputs: [
      { name: 'student', label: 'Student' },
      { name: 'tone', label: 'Tone', default: 'info' },
    ],
    outputs: [{ name: 'selected', label: 'Selected' }],
    blocks: [
      {
        ...createBlock('button'),
        logic: { text: { var: 'props.student.name' } },
        on: { click: `${OUTPUT_PREFIX}selected` },
      },
    ],
  }
  project.components = [card]
  project.pages[0].blocks = [
    {
      ...createBlock('component'),
      componentId: 'student-card',
      props: { student: { var: 'item' } },
      outputs: { selected: open.id },
    },
  ]
  return { project, open }
}

describe('component inputs and outputs', () => {
  it("validates placements against the component's inputs and outputs", () => {
    const { project } = cardApp()
    expect(() => parseProject(JSON.stringify(project))).not.toThrow()
    project.pages[0].blocks[0].props = { colour: 'red' }
    expect(() => parseProject(JSON.stringify(project))).toThrow(
      /does not have as an input/,
    )
    project.pages[0].blocks[0].props = {}
    project.pages[0].blocks[0].outputs = { selected: 'missing-flow' }
    expect(() => parseProject(JSON.stringify(project))).toThrow(
      /runs a flow that no longer exists/,
    )
  })

  it('fills defaults when expanding, and keeps the output wiring for the runtime', () => {
    const { project, open } = cardApp()
    const expanded = expandProject(project)
    const instance = expanded.pages[0].blocks[0]
    expect(instance.props).toEqual({ tone: 'info', student: { var: 'item' } })
    expect(instance.outputs).toEqual({ selected: open.id })
    expect(instance.children[0].on).toEqual({ click: '@output:selected' })
    // The expanded copy (what visitors get) is still a valid app.
    expect(() => parseProject(JSON.stringify(expanded))).not.toThrow()
  })
})

describe('importing APIs and component ports', () => {
  it('imports saved APIs, api steps, component inputs/outputs and output events', () => {
    const { project, warnings } = importJson({
      name: 'Portal',
      apis: [
        {
          id: 'get-student',
          name: 'Get student',
          url: 'https://api.school.edu/students/:id',
          auth: { type: 'bearer', secret: 'secrets.SCHOOL_TOKEN' },
        },
      ],
      components: [
        {
          id: 'student-card',
          name: 'Student card',
          inputs: ['student'],
          outputs: [{ name: 'selected' }],
          blocks: [
            {
              type: 'button',
              logic: { text: { var: 'props.student.name' } },
              on: { click: '@output:selected' },
            },
          ],
        },
      ],
      pages: [
        {
          name: 'Home',
          blocks: [
            {
              type: 'component',
              componentId: 'Student card',
              props: { student: { var: 'item' }, colour: 'red' },
              outputs: { selected: 'Load student' },
            },
          ],
        },
      ],
      flows: [
        {
          id: 'load-student',
          name: 'Load student',
          steps: [
            {
              id: 'get',
              type: 'api',
              apiId: 'Get student',
              args: { id: { var: 'event.value.student.id' } },
            },
          ],
        },
      ],
    })
    const api = project.apis![0]
    expect(api.url).toBe('https://api.school.edu/students/{id}')
    expect(api.params).toEqual([{ name: 'id', in: 'path', required: true }])
    expect(api.auth).toEqual({ type: 'bearer', secret: 'SCHOOL_TOKEN' })
    expect(project.flows[0].steps[0]).toMatchObject({
      type: 'api',
      apiId: 'get-student',
      args: { id: { var: 'event.value.student.id' } },
    })
    expect(project.components![0]).toMatchObject({
      inputs: [{ name: 'student', label: 'student' }],
      outputs: [{ name: 'selected', label: 'selected' }],
    })
    expect(project.components![0].blocks[0].on).toEqual({
      click: '@output:selected',
    })
    const placed = project.pages[0].blocks[0]
    expect(placed.props).toEqual({ student: { var: 'item' } })
    expect(placed.outputs).toEqual({ selected: 'load-student' })
    expect(warnings.some((warning) => /colour/.test(warning))).toBe(true)
  })

  it('still reads "api" steps with a URL as plain web calls', () => {
    const { project } = importJson({
      pages: [{ name: 'Home', blocks: [] }],
      flows: [
        { name: 'Fetch', steps: [{ type: 'api', url: 'https://x.test/data' }] },
      ],
    })
    expect(project.flows[0].steps[0].type).toBe('http')
  })
})

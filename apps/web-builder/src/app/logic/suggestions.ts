import { Project, pathParams } from '@spsedu360/engine/model'
import { Flow } from '@spsedu360/engine/flow'

/** Variable names offered in logic editors, so non-technical users can pick instead of type. */
export function variableSuggestions(
  project: Project,
  extra: string[] = [],
): string[] {
  const names = new Set<string>(extra)
  for (const variable of project.variables)
    names.add(`${variable.scope}.${variable.name}`)
  for (const page of project.pages)
    for (const param of pathParams(page.path)) names.add(`params.${param}`)
  for (const flow of project.flows) {
    names.add(`flows.${flow.id}.output`)
    names.add(`flows.${flow.id}.status`)
    for (const step of flow.steps)
      if (step.saveAs) names.add(`${step.saveAs.scope}.${step.saveAs.name}`)
      else if (step.type === 'setVariable' && step.variable)
        names.add(`${step.scope ?? 'vars'}.${step.variable}`)
  }
  for (const name of [
    'data',
    'item',
    'index',
    'event.value',
    'event.form',
    'event.item',
    'page.name',
    'query.',
  ])
    names.add(name)
  return [...names]
}

/** Extra names available inside one flow: its steps' outputs, input and error details. */
export function flowSuggestions(flow: Flow): string[] {
  return [
    ...flow.steps.map((step) => `steps.${step.id}`),
    'input',
    'input.result',
    'input.error',
    'error.message',
    'error.status',
    'response',
    'result',
    'secrets.',
  ]
}

/** Sample data used to preview logic results in the editor. */
export function sampleContext(
  project: Project,
  params: Record<string, string> = {},
): Record<string, unknown> {
  const scopes: Record<string, Record<string, unknown>> = {
    vars: {},
    session: {},
    local: {},
  }
  for (const variable of project.variables)
    scopes[variable.scope][variable.name] = variable.initial ?? null
  const allParams: Record<string, string> = {}
  for (const page of project.pages)
    for (const param of pathParams(page.path))
      allParams[param] = params[param] ?? `sample-${param}`
  return {
    ...scopes,
    params: allParams,
    query: {},
    flows: {},
    data: null,
    item: null,
    index: 0,
    event: {},
    input: {},
    steps: {},
    page: { name: '', path: '' },
  }
}

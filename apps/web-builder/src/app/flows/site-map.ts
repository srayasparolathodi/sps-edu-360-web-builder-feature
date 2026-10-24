import { Component, computed, inject, viewChild } from '@angular/core'
import {
  MatDialog,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog'
import { MatButtonModule } from '@angular/material/button'
import { MatIconModule } from '@angular/material/icon'
import { MatTooltipModule } from '@angular/material/tooltip'
import { FCanvasComponent, FFlowModule } from '@foblex/flow'
import {
  Block,
  Project,
  pathParams,
  resolvePage,
} from '@spsedu360/engine/model'
import { isLogic } from '@spsedu360/engine/logic'
import { BuilderStore } from '../builder-store'
import { FlowEditor } from './flow-editor'

interface MapNode {
  id: string
  kind: 'page' | 'flow'
  title: string
  subtitle: string
  icon: string
  position: { x: number; y: number }
}
interface MapEdge {
  id: string
  source: string
  target: string
  label: string
}

/** Every literal link inside a page's blocks. */
function blockLinks(blocks: Block[]): string[] {
  const links: string[] = []
  const visit = (items: Block[]) =>
    items.forEach((block) => {
      if (block.url && !isLogic(block.logic?.url)) links.push(block.url)
      if (['navigation', 'breadcrumb', 'menu'].includes(block.type))
        for (const line of block.options.split('\n'))
          if (line.split('|')[1]) links.push(line.split('|')[1])
      visit(block.children)
    })
  visit(blocks)
  return links
}

function blockFlows(blocks: Block[]): { flowId: string; label: string }[] {
  const result: { flowId: string; label: string }[] = []
  const visit = (items: Block[]) =>
    items.forEach((block) => {
      if (block.source)
        result.push({ flowId: block.source, label: `data for ${block.name}` })
      for (const [event, flowId] of Object.entries(block.on ?? {}))
        if (flowId) result.push({ flowId, label: `${block.name}: ${event}` })
      visit(block.children)
    })
  visit(blocks)
  return result
}

export function siteGraph(project: Project): {
  nodes: MapNode[]
  edges: MapEdge[]
} {
  const nodes: MapNode[] = []
  const edges = new Map<string, MapEdge>()
  const edge = (source: string, target: string, label: string) => {
    const id = `${source}->${target}`
    const existing = edges.get(id)
    if (existing)
      existing.label = existing.label.includes(label)
        ? existing.label
        : `${existing.label}, ${label}`
    else edges.set(id, { id, source, target, label })
  }
  const pageFor = (link: string) => {
    const path = link.trim()
    if (!path || /^(https?:|mailto:|tel:)/i.test(path)) return null
    return (
      resolvePage(project, path.replace(/^#/, '').split('?')[0])?.page ?? null
    )
  }
  project.pages.forEach((page, index) => {
    const params = pathParams(page.path)
    nodes.push({
      id: `page-${page.id}`,
      kind: 'page',
      title: page.name,
      subtitle: `/${page.path}${params.length ? '' : ''}`,
      icon: params.length ? 'route' : index === 0 ? 'home' : 'description',
      position: { x: 40, y: 40 + index * 170 },
    })
    for (const link of blockLinks(page.blocks)) {
      const target = pageFor(link)
      if (target && target.id !== page.id)
        edge(`page-${page.id}`, `page-${target.id}`, 'link')
    }
    for (const { flowId, label } of blockFlows(page.blocks))
      edge(`page-${page.id}`, `flow-${flowId}`, label)
  })
  project.flows.forEach((flow, index) => {
    nodes.push({
      id: `flow-${flow.id}`,
      kind: 'flow',
      title: flow.name,
      subtitle: `${flow.runAt === 'server' ? 'Server' : 'Browser'} · ${flow.steps.length} steps · ${flow.trigger === 'pageLoad' ? 'on page open' : flow.trigger === 'interval' ? `every ${flow.intervalSeconds}s` : 'on event'}`,
      icon: flow.runAt === 'server' ? 'dns' : 'account_tree',
      position: { x: 420, y: 40 + index * 150 },
    })
    if (flow.trigger !== 'manual')
      for (const page of project.pages)
        if (!flow.pageIds.length || flow.pageIds.includes(page.id))
          edge(
            `page-${page.id}`,
            `flow-${flow.id}`,
            flow.trigger === 'interval' ? 'repeats' : 'on open',
          )
    for (const step of flow.steps) {
      if (step.type === 'navigate' && typeof step.to === 'string') {
        const target = pageFor(step.to)
        if (target) edge(`flow-${flow.id}`, `page-${target.id}`, 'goes to')
      }
      if (step.type === 'serverFlow' && step.flowId)
        edge(`flow-${flow.id}`, `flow-${step.flowId}`, 'calls')
    }
    if (flow.onSuccess)
      edge(`flow-${flow.id}`, `flow-${flow.onSuccess}`, 'then')
    if (flow.onFailure)
      edge(`flow-${flow.id}`, `flow-${flow.onFailure}`, 'on failure')
  })
  const ids = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: [...edges.values()].filter(
      (item) => ids.has(item.source) && ids.has(item.target),
    ),
  }
}

@Component({
  selector: 'site-map',
  imports: [
    FFlowModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
  ],
  template: `
    <header class="flow-header">
      <mat-icon class="brand-icon">hub</mat-icon>
      <h2 class="map-title">Site map — pages, paths and flows</h2>
      <span class="toolbar-spacer"></span>
      <button mat-stroked-button (click)="fit()">
        <mat-icon>fit_screen</mat-icon>Fit
      </button>
      <button mat-icon-button aria-label="Close site map" (click)="ref.close()">
        <mat-icon>close</mat-icon>
      </button>
    </header>
    <div class="flow-canvas map-canvas">
      <f-flow fDraggable (fFullRendered)="fit()">
        <f-background><f-circle-pattern /></f-background>
        <f-canvas fZoom>
          <ng-container ngProjectAs="[fConnections]">
            @for (e of graph().edges; track e.id) {
              <f-connection
                [fConnectionId]="e.id"
                [fSourceId]="'out-' + e.source"
                [fTargetId]="'in-' + e.target"
                fType="bezier"
                ><div fConnectionContent class="map-edge-label">
                  {{ e.label }}
                </div></f-connection
              >
            }
          </ng-container>
          <ng-container ngProjectAs="[fNodes]">
            @for (n of graph().nodes; track n.id) {
              <div
                fNode
                fDragHandle
                [fNodeId]="n.id"
                [fNodePosition]="n.position"
                [class]="'flow-node map-' + n.kind"
                (dblclick)="open(n)"
              >
                <div
                  fConnector
                  fConnectorType="target"
                  [fConnectorId]="'in-' + n.id"
                  [fConnectorMultiple]="true"
                  class="flow-connector in"
                ></div>
                <mat-icon>{{ n.icon }}</mat-icon>
                <div class="flow-node-text">
                  <strong>{{ n.title }}</strong
                  ><span>{{ n.subtitle }}</span>
                </div>
                <div
                  fConnector
                  fConnectorType="source"
                  [fConnectorId]="'out-' + n.id"
                  [fConnectorMultiple]="true"
                  class="flow-connector out"
                ></div>
              </div>
            }
          </ng-container>
        </f-canvas>
      </f-flow>
    </div>
    <p class="map-legend muted">
      <mat-icon>route</mat-icon>Pages with path variables ·
      <mat-icon>account_tree</mat-icon>Browser flow ·
      <mat-icon>dns</mat-icon>Server flow · Double-click a node to open it.
    </p>
  `,
})
export class SiteMap {
  readonly store = inject(BuilderStore)
  readonly ref = inject(MatDialogRef<SiteMap>)
  private readonly dialog = inject(MatDialog)
  private readonly canvas = viewChild(FCanvasComponent)
  readonly graph = computed(() => siteGraph(this.store.project()))

  fit(): void {
    this.canvas()?.fitToScreen({ x: 60, y: 60 }, false, false, 1)
  }

  open(node: MapNode): void {
    if (node.kind === 'page') {
      this.store.pageId.set(node.id.slice(5))
      this.store.selectedId.set('')
      this.ref.close()
    } else {
      this.dialog.open(FlowEditor, {
        data: { flowId: node.id.slice(5) },
        panelClass: 'fullscreen-dialog',
        maxWidth: '100vw',
        width: '100vw',
        height: '100dvh',
        autoFocus: false,
      })
    }
  }
}

import { Component, computed, inject, signal } from '@angular/core'
import { DatePipe } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { Router, RouterLink } from '@angular/router'
import { MatButtonModule } from '@angular/material/button'
import { MatIconModule } from '@angular/material/icon'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatInputModule } from '@angular/material/input'
import { MatMenuModule } from '@angular/material/menu'
import { MatTooltipModule } from '@angular/material/tooltip'
import { MatSnackBar } from '@angular/material/snack-bar'
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner'
import { Project, parseProject } from '@spsedu360/engine/model'
import { ApiService, ProjectSummary } from '../services/api'
import { TEMPLATES, Template } from './templates'
import { MatDialog } from '@angular/material/dialog'
import { PeopleDialog } from './people-dialog'
import { ImportDialog } from './import-dialog'
import { BuilderUser } from '../services/api'

@Component({
  selector: 'landing-page',
  imports: [
    FormsModule,
    RouterLink,
    DatePipe,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatMenuModule,
    MatTooltipModule,
    MatProgressSpinnerModule,
  ],
  templateUrl: './landing.html',
})
export class LandingPage {
  readonly api = inject(ApiService)
  private readonly router = inject(Router)
  private readonly snack = inject(MatSnackBar)
  private readonly dialog = inject(MatDialog)
  liveUrl(project: ProjectSummary): string {
    const origin = this.api.sitesOrigin() || location.origin
    return project.slug
      ? `${origin}/${project.slug}`
      : `${origin}/site/${project.id}`
  }
  readonly isAdmin = computed(() => this.api.user()?.role === 'admin')
  /** Authors build one app in the cloud; it can hold any number of pages, journeys and versions. */
  readonly atLimit = computed(
    () =>
      this.api.isCloud() &&
      this.api.user()?.role === 'author' &&
      (this.projects()?.length ?? 0) >= 1,
  )
  readonly people = signal<BuilderUser[]>([])
  ownerEmail(id: string | null | undefined): string {
    if (!id) return 'No owner'
    if (id === this.api.user()?.id && this.api.user()?.via === 'token')
      return 'Admin token'
    return (
      this.people().find((person) => person.id === id)?.email ?? 'Unknown user'
    )
  }
  openPeople(): void {
    this.dialog
      .open(PeopleDialog, { width: '620px', maxWidth: 'calc(100vw - 32px)' })
      .afterClosed()
      .subscribe(() => void this.loadPeople())
  }
  private async loadPeople(): Promise<void> {
    if (!this.isAdmin()) return
    try {
      this.people.set(await this.api.users())
    } catch {
      this.people.set([])
    }
  }
  async setOwner(summary: ProjectSummary, person: BuilderUser): Promise<void> {
    try {
      await this.api.setOwner(summary.id, person.id)
      await this.refresh()
      this.snack.open(
        `${summary.name} now belongs to ${person.email}.`,
        'Close',
        { duration: 4000 },
      )
    } catch (error) {
      this.snack.open(
        error instanceof Error ? error.message : 'Could not change the owner.',
        'Close',
        { duration: 5000 },
      )
    }
  }

  readonly templates = TEMPLATES
  readonly projects = signal<ProjectSummary[] | null>(null)
  readonly error = signal('')
  readonly search = signal('')
  readonly token = signal('')
  readonly connecting = signal(false)
  readonly creating = signal('')
  readonly newName = signal('')
  readonly filtered = computed(() => {
    const term = this.search().toLowerCase()
    return (this.projects() ?? []).filter((project) =>
      project.name.toLowerCase().includes(term),
    )
  })

  constructor() {
    void this.refresh()
  }

  initials(name: string): string {
    return (
      name
        .trim()
        .split(/\s+/)
        .slice(0, 2)
        .map((word) => word[0]?.toUpperCase() ?? '')
        .join('') || 'P'
    )
  }

  /** Stable hue per project so each card's monogram is recognisable. */
  hue(name: string): number {
    let hash = 0
    for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) % 360
    return hash
  }

  async refresh(): Promise<void> {
    this.error.set('')
    this.projects.set(null)
    try {
      this.projects.set(await this.api.list())
      void this.loadPeople()
    } catch (error) {
      this.error.set(
        error instanceof Error
          ? error.message
          : 'Projects could not be loaded.',
      )
      this.projects.set([])
    }
  }

  async connect(): Promise<void> {
    this.connecting.set(true)
    const ok = await this.api.signIn(this.token())
    this.connecting.set(false)
    this.token.set('')
    this.snack.open(
      ok
        ? 'Connected to cloud storage.'
        : this.api.cloudIssue() || 'Could not connect.',
      'Close',
      { duration: 4000 },
    )
    await this.refresh()
  }

  disconnect(): void {
    this.api.signOut()
    void this.refresh()
  }

  async create(template: Template): Promise<void> {
    const name = this.newName().trim() || template.name
    this.creating.set(template.id)
    try {
      const project = template.create(name)
      await this.api.save(project)
      await this.router.navigate(['/builder', project.id])
    } catch (error) {
      this.snack.open(
        error instanceof Error
          ? error.message
          : 'The project could not be created.',
        'Close',
        { duration: 6000 },
      )
    } finally {
      this.creating.set('')
    }
  }

  async duplicate(summary: ProjectSummary): Promise<void> {
    try {
      const original = await this.api.get(summary.id)
      const copy: Project = {
        ...structuredClone(original),
        id: crypto.randomUUID(),
        name: `${original.name} copy`,
      }
      await this.api.save(copy)
      await this.refresh()
      this.snack.open('Project duplicated.', 'Close', { duration: 2500 })
    } catch (error) {
      this.snack.open(
        error instanceof Error ? error.message : 'Could not duplicate.',
        'Close',
        { duration: 5000 },
      )
    }
  }

  async remove(summary: ProjectSummary): Promise<void> {
    if (
      !confirm(
        `Delete “${summary.name}”${summary.publishedAt ? ' and take its live site offline' : ''}? This cannot be undone.`,
      )
    )
      return
    try {
      await this.api.remove(summary.id)
      await this.refresh()
    } catch (error) {
      this.snack.open(
        error instanceof Error ? error.message : 'Could not delete.',
        'Close',
        { duration: 5000 },
      )
    }
  }

  /** Import an app from JSON (pasted, uploaded, or written by an AI assistant from our instructions). */
  openImport(startTab = 0): void {
    this.dialog.open(ImportDialog, {
      width: '760px',
      maxWidth: 'calc(100vw - 32px)',
      autoFocus: false,
      data: {
        startTab,
        apply: async (project: Project) => {
          // Imported apps always get a fresh id so they never overwrite another app.
          const copy: Project = { ...project, id: crypto.randomUUID() }
          await this.api.save(copy)
          await this.router.navigate(['/builder', copy.id])
        },
      },
    })
  }
}

import { Component, DestroyRef, computed, inject, signal } from '@angular/core'
import { DOCUMENT, DatePipe } from '@angular/common'
import { FormsModule } from '@angular/forms'
import { MAT_DIALOG_DATA, MatDialogModule } from '@angular/material/dialog'
import { MatButtonModule } from '@angular/material/button'
import { MatIconModule } from '@angular/material/icon'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatInputModule } from '@angular/material/input'
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner'
import { MatTooltipModule } from '@angular/material/tooltip'
import { siteUrl, slugForName } from '@spsedu360/engine/address'
import {
  EntityKind,
  EntityState,
  EntityStatus,
  EntityVersion,
} from '@spsedu360/engine/publishing'
import { BuilderStore } from '../builder-store'
import { ApiService } from '../services/api'

export interface PublishDialogData {
  store: BuilderStore
}

const STATE_LABEL: Record<EntityState, string> = {
  live: 'Live',
  changed: 'Changed since live',
  review: 'Needs review',
  draft: 'Draft',
  deleted: 'Deleted, still live',
}

/**
 * Publish an app part by part: components, then the pages that use them, then the app settings.
 * Each part shows whether it is live, its last versions, and what needs review.
 */
@Component({
  selector: 'publish-dialog',
  imports: [
    DatePipe,
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatProgressSpinnerModule,
    MatTooltipModule,
  ],
  template: `
    <h2 mat-dialog-title>Publish</h2>
    <mat-dialog-content class="publish-dialog">
      <div class="publish-address">
        <mat-form-field
          appearance="outline"
          class="full-width"
          subscriptSizing="dynamic"
        >
          <mat-label>App name</mat-label>
          <input
            matInput
            name="name"
            autocomplete="off"
            maxlength="200"
            [ngModel]="name()"
            (ngModelChange)="setName($event)"
            (blur)="saveName()"
            (keydown.enter)="saveName()"
          />
          @if (checking()) {
            <mat-progress-spinner
              matSuffix
              diameter="18"
              mode="indeterminate"
            />
          } @else if (nameTaken()) {
            <mat-icon matSuffix class="bad-icon">error</mat-icon>
          }
        </mat-form-field>
        <div class="live-link">
          <mat-icon>{{ appLive() ? 'public' : 'link' }}</mat-icon>
          @if (appLive()) {
            <a [href]="url()" target="_blank" rel="noopener">{{ url() }}</a>
          } @else {
            <span>{{ url() }}</span>
          }
          <span class="toolbar-spacer"></span>
          <button
            mat-icon-button
            [matTooltip]="copied() ? 'Copied' : 'Copy link'"
            aria-label="Copy link"
            (click)="copy()"
          >
            <mat-icon>{{ copied() ? 'check' : 'content_copy' }}</mat-icon>
          </button>
        </div>
        @if (nameTaken()) {
          <p class="logic-result failed" role="alert">
            <mat-icon>error_outline</mat-icon>{{ nameTaken() }}
          </p>
        }
        <p class="muted">
          The app name is its web address and is unique. Pages add their path
          after it, e.g. <code>{{ url() }}/students/42?tab=marks</code>.
        </p>
      </div>
      <p class="publish-order">
        <mat-icon>info</mat-icon>Publish in this order: components, then the
        pages that use them, then the app. Each part keeps its last two
        versions; only one version of each is live.
      </p>
      @if (error()) {
        <p class="logic-result failed" role="alert">
          <mat-icon>error_outline</mat-icon>{{ error() }}
        </p>
      }
      @if (statuses() === null) {
        <div class="version-loading"><mat-spinner diameter="24" /></div>
      } @else {
        @for (section of sections(); track section.kind) {
          @if (section.items.length) {
            <h3 class="panel-title">{{ section.title }}</h3>
            <ul class="part-list">
              @for (item of section.items; track item.kind + item.id) {
                <li class="part-row" [class]="'part-row state-' + item.state">
                  <div class="part-head">
                    <mat-icon>{{ section.icon }}</mat-icon>
                    <strong>{{ item.name }}</strong>
                    <span class="state-chip"
                      >{{ label(item.state) }}
                      @if (item.liveVersion) {
                        · v{{ item.liveVersion }} live
                      }
                    </span>
                    <span class="toolbar-spacer"></span>
                    @if (item.state !== 'live' && item.state !== 'deleted') {
                      <button
                        mat-flat-button
                        [disabled]="busy()"
                        (click)="act('publish', item)"
                      >
                        <mat-icon>rocket_launch</mat-icon
                        >{{
                          item.state === 'review'
                            ? 'Publish again'
                            : item.liveVersion
                              ? 'Publish v' + item.latestVersion
                              : 'Publish'
                        }}
                      </button>
                    }
                    @if (item.liveVersion) {
                      <button
                        mat-button
                        [disabled]="busy()"
                        (click)="act('unpublish', item)"
                      >
                        {{
                          item.kind === 'app' ? 'Take app offline' : 'Unpublish'
                        }}
                      </button>
                    }
                  </div>
                  @for (reason of item.reasons; track reason) {
                    <p class="part-note">
                      <mat-icon>rate_review</mat-icon>{{ reason }} Check the
                      page, then publish it.
                    </p>
                  }
                  @if (item.kind === 'component' && item.usedBy.length) {
                    <p class="part-note">
                      <mat-icon>link</mat-icon>Used on
                      {{ item.usedBy.join(', ') }}. After publishing this
                      component, review and publish each of those pages.
                    </p>
                  }
                  @if (item.versions.length) {
                    <div class="part-versions">
                      @for (version of item.versions; track version.version) {
                        <span
                          class="version-pill"
                          [class.is-live]="version.status === 'published'"
                        >
                          v{{ version.version }} ·
                          {{
                            version.status === 'published' ? 'live' : 'draft'
                          }}
                          · {{ version.createdAt | date: 'MMM d, h:mm a' }}
                          @if (
                            version.version !== item.latestVersion &&
                            item.state !== 'deleted'
                          ) {
                            <button
                              mat-button
                              class="restore-button"
                              [disabled]="busy()"
                              (click)="restore(item, version)"
                            >
                              Restore
                            </button>
                          }
                        </span>
                      }
                    </div>
                  }
                </li>
              }
            </ul>
          }
        }
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end"
      ><button mat-button mat-dialog-close>Close</button></mat-dialog-actions
    >
  `,
})
export class PublishDialog {
  private readonly api = inject(ApiService)
  readonly store = inject<PublishDialogData>(MAT_DIALOG_DATA).store
  readonly origin = inject(DOCUMENT).location.origin
  readonly statuses = signal<EntityStatus[] | null>(null)
  readonly busy = signal(false)
  readonly error = signal('')
  readonly copied = signal(false)
  readonly name = signal(this.store.project().name)
  readonly checking = signal(false)
  readonly nameTaken = signal('')
  readonly slug = computed(() =>
    slugForName(this.name(), this.store.project().id),
  )
  readonly url = computed(() => siteUrl(this.origin, this.slug()))
  readonly appLive = computed(
    () => !!this.statuses()?.find((item) => item.kind === 'app')?.liveVersion,
  )
  readonly sections = computed(() => {
    const all = this.statuses() ?? []
    const of = (kind: EntityKind) => all.filter((item) => item.kind === kind)
    return [
      {
        kind: 'component',
        title: 'Components',
        icon: 'widgets',
        items: of('component'),
      },
      { kind: 'page', title: 'Pages', icon: 'description', items: of('page') },
      {
        kind: 'app',
        title: 'App settings: journeys, variables, sign-in, page order',
        icon: 'apps',
        items: of('app'),
      },
    ]
  })
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer))
    void this.load()
  }

  label(state: EntityState): string {
    return STATE_LABEL[state]
  }

  private async load(): Promise<void> {
    this.error.set('')
    try {
      // What is compared with the live app is the saved draft, so save pending edits first.
      if (this.store.dirty()) await this.store.save()
      this.statuses.set(
        (await this.api.publishing(this.store.project().id)).statuses,
      )
    } catch (error) {
      this.statuses.set([])
      this.error.set(
        error instanceof Error
          ? error.message
          : 'Publishing details could not be loaded.',
      )
    }
  }

  setName(value: string): void {
    this.name.set(value)
    this.nameTaken.set('')
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.check(), 350)
  }

  private async check(): Promise<void> {
    const name = this.name().trim()
    if (!name) return this.nameTaken.set('Give the app a name.')
    this.checking.set(true)
    try {
      const result = await this.api.nameAvailable(name, this.store.project().id)
      if (name === this.name().trim())
        this.nameTaken.set(result.available ? '' : result.reason)
    } finally {
      this.checking.set(false)
    }
  }

  /** Renaming changes the address; it is saved (and checked) right away. */
  async saveName(): Promise<void> {
    const name = this.name().trim()
    if (!name || name === this.store.project().name || this.nameTaken()) return
    this.store.change((project) => {
      project.name = name
    })
    try {
      await this.store.save()
      await this.load()
    } catch (error) {
      this.nameTaken.set(
        error instanceof Error ? error.message : 'The name could not be saved.',
      )
    }
  }

  async act(
    action: 'publish' | 'unpublish',
    item: EntityStatus,
  ): Promise<void> {
    if (
      action === 'unpublish' &&
      !confirm(
        item.kind === 'app'
          ? 'Take the whole app offline? Visitors will see “not available”.'
          : `Unpublish “${item.name}”?`,
      )
    )
      return
    this.busy.set(true)
    this.error.set('')
    try {
      if (this.store.dirty()) await this.store.save()
      const result = await this.api.publishPart(
        this.store.project().id,
        action,
        item.kind,
        item.id,
      )
      this.statuses.set(result.statuses)
      this.store.applySummary(result)
    } catch (error) {
      this.error.set(
        error instanceof Error ? error.message : 'That did not work.',
      )
    } finally {
      this.busy.set(false)
    }
  }

  async restore(item: EntityStatus, version: EntityVersion): Promise<void> {
    if (
      !confirm(
        `Put version ${version.version} of “${item.name}” back into the draft? It stays a draft until you publish it.`,
      )
    )
      return
    this.busy.set(true)
    this.error.set('')
    try {
      if (this.store.dirty()) await this.store.save()
      this.store.replaceDraft(
        await this.api.restorePart(
          this.store.project().id,
          item.kind,
          item.id,
          version.version,
        ),
      )
      this.name.set(this.store.project().name)
      await this.load()
    } catch (error) {
      this.error.set(
        error instanceof Error
          ? error.message
          : 'The version could not be restored.',
      )
    } finally {
      this.busy.set(false)
    }
  }

  async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.url())
      this.copied.set(true)
      setTimeout(() => this.copied.set(false), 2000)
    } catch {
      this.error.set(this.url())
    }
  }
}

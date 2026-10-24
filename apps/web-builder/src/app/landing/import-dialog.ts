import { Component, DestroyRef, computed, inject, signal } from '@angular/core'
import { FormsModule } from '@angular/forms'
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog'
import { MatButtonModule } from '@angular/material/button'
import { MatIconModule } from '@angular/material/icon'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatInputModule } from '@angular/material/input'
import { MatTabsModule } from '@angular/material/tabs'
import { MatExpansionModule } from '@angular/material/expansion'
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner'
import { Project } from '@spsedu360/engine/model'
import {
  ImportResult,
  aiPrompt,
  fixPrompt,
  importJson,
} from '@spsedu360/engine/ai-import'

export interface ImportDialogData {
  /** Add pages, components and flows to this app instead of creating a new one. */
  existing?: Project
  /** Saves the result; throws with a message the dialog shows (e.g. the app name is taken). */
  apply: (project: Project) => Promise<void>
  /** 0: create with AI, 1: paste JSON. */
  startTab?: number
}

/**
 * Import an app (or pages into an app) from JSON: written by any AI assistant from the
 * instructions we provide, pasted, or uploaded as a file.
 */
@Component({
  selector: 'import-dialog',
  imports: [
    FormsModule,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatTabsModule,
    MatExpansionModule,
    MatProgressSpinnerModule,
  ],
  template: `
    <h2 mat-dialog-title>
      {{ adding ? 'Add pages with AI or JSON' : 'Import an app' }}
    </h2>
    <mat-dialog-content class="import-dialog">
      <mat-tab-group
        mat-stretch-tabs="false"
        [selectedIndex]="tab()"
        (selectedIndexChange)="tab.set($event)"
        animationDuration="0"
      >
        <mat-tab label="1. Create with AI">
          <div class="import-pane">
            <p>
              Use any AI assistant (ChatGPT, Claude, Gemini, GitHub Copilot…) to
              design {{ adding ? 'new pages for this app' : 'your app' }}. Our
              instructions tell it exactly which blocks, journeys and settings
              Page Studio understands, so its answer imports cleanly.
            </p>
            <mat-form-field appearance="outline" class="full-width">
              <mat-label>What do you need? (optional)</mat-label>
              <textarea
                matInput
                rows="6"
                [ngModel]="requirements()"
                (ngModelChange)="requirements.set($event)"
                placeholder="e.g. A school portal: home page with a banner and news, an admissions form that emails the office, a teachers page loaded from our API (https://…), and a parent login that shows only their child's marks."
              ></textarea>
              <mat-hint
                >You can also explain this to the assistant directly, and attach
                screenshots or Figma designs there.</mat-hint
              >
            </mat-form-field>
            <ol class="import-steps">
              <li>
                <button mat-flat-button type="button" (click)="copyPrompt()">
                  <mat-icon>{{ copied() ? 'check' : 'content_copy' }}</mat-icon
                  >{{
                    copied()
                      ? 'Instructions copied'
                      : 'Copy instructions for the AI'
                  }}
                </button>
              </li>
              <li>
                Paste them into your AI assistant. Attach screenshots or Figma
                exports of the design, and describe how each part should work.
              </li>
              <li>
                Copy the JSON it answers with, then
                <button
                  mat-button
                  type="button"
                  class="inline-link"
                  (click)="tab.set(1)"
                >
                  paste it here</button
                >.
              </li>
            </ol>
            <mat-expansion-panel class="prompt-preview">
              <mat-expansion-panel-header
                ><mat-panel-title
                  >See the instructions ({{
                    promptText().length.toLocaleString()
                  }}
                  characters)</mat-panel-title
                ></mat-expansion-panel-header
              >
              <textarea
                class="prompt-text"
                readonly
                [value]="promptText()"
                aria-label="Instructions for the AI assistant"
              ></textarea>
            </mat-expansion-panel>
          </div>
        </mat-tab>
        <mat-tab label="2. Paste JSON">
          <div class="import-pane">
            <mat-form-field appearance="outline" class="full-width">
              <mat-label
                >JSON from the AI assistant or an exported app</mat-label
              >
              <textarea
                matInput
                rows="12"
                class="json-input"
                spellcheck="false"
                [ngModel]="json()"
                (ngModelChange)="setJson($event)"
                placeholder='{ "name": "…", "pages": [ … ] }'
              ></textarea>
              <mat-hint
                >Extra text or code fences around the JSON are fine.</mat-hint
              >
            </mat-form-field>
            <label class="file-pick"
              ><mat-icon>upload_file</mat-icon>Or choose a .json file<input
                type="file"
                accept="application/json,.json,.txt"
                class="visually-hidden"
                (change)="pickFile($event)"
            /></label>
            @if (error()) {
              <div class="import-result failed" role="alert">
                <mat-icon>error_outline</mat-icon>
                <div>
                  <strong>This can't be imported yet</strong
                  ><span>{{ error() }}</span>
                  <button mat-stroked-button type="button" (click)="copyFix()">
                    <mat-icon>{{
                      fixCopied() ? 'check' : 'content_copy'
                    }}</mat-icon
                    >{{
                      fixCopied()
                        ? 'Copied: paste it to the assistant'
                        : 'Copy a fix request for the assistant'
                    }}
                  </button>
                </div>
              </div>
            } @else if (result(); as checked) {
              <div class="import-result ok" role="status">
                <mat-icon>check_circle</mat-icon>
                <div>
                  <strong>Ready to import</strong>
                  <span
                    >{{ checked.summary.pages }} page{{
                      checked.summary.pages === 1 ? '' : 's'
                    }}
                    · {{ checked.summary.components }} component{{
                      checked.summary.components === 1 ? '' : 's'
                    }}
                    · {{ checked.summary.flows }} journey{{
                      checked.summary.flows === 1 ? '' : 's'
                    }}
                    · {{ checked.summary.blocks }} blocks ·
                    {{ checked.summary.variables }} variable{{
                      checked.summary.variables === 1 ? '' : 's'
                    }}</span
                  >
                  <span class="muted">Pages: {{ pageList() }}</span>
                </div>
              </div>
              @if (checked.warnings.length) {
                <mat-expansion-panel class="import-warnings">
                  <mat-expansion-panel-header
                    ><mat-panel-title
                      ><mat-icon>build</mat-icon
                      >{{ checked.warnings.length }} thing{{
                        checked.warnings.length === 1 ? '' : 's'
                      }}
                      were fixed automatically</mat-panel-title
                    ></mat-expansion-panel-header
                  >
                  <ul>
                    @for (warning of checked.warnings; track warning) {
                      <li>{{ warning }}</li>
                    }
                  </ul>
                </mat-expansion-panel>
              }
              @if (checked.notes.length) {
                <mat-expansion-panel class="import-warnings" expanded>
                  <mat-expansion-panel-header
                    ><mat-panel-title
                      ><mat-icon>fact_check</mat-icon
                      >{{ checked.notes.length }} thing{{
                        checked.notes.length === 1 ? '' : 's'
                      }}
                      for you to check</mat-panel-title
                    ></mat-expansion-panel-header
                  >
                  <ul>
                    @for (note of checked.notes; track note) {
                      <li>{{ note }}</li>
                    }
                  </ul>
                </mat-expansion-panel>
              }
              @if (!adding) {
                <mat-form-field appearance="outline" class="full-width">
                  <mat-label>App name</mat-label>
                  <input
                    matInput
                    [ngModel]="appName()"
                    (ngModelChange)="appName.set($event)"
                    maxlength="200"
                  />
                  <mat-hint
                    >Becomes the app's web address; it must be unique.</mat-hint
                  >
                </mat-form-field>
              }
            }
          </div>
        </mat-tab>
      </mat-tab-group>
      @if (saveError()) {
        <p class="logic-result failed" role="alert">
          <mat-icon>error_outline</mat-icon>{{ saveError() }}
        </p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancel</button>
      <button
        mat-flat-button
        [disabled]="!result() || busy() || (!adding && !appName().trim())"
        (click)="save()"
      >
        @if (busy()) {
          <mat-spinner diameter="16" />
        } @else {
          <mat-icon>download_done</mat-icon>
        }
        {{ adding ? 'Add to this app' : 'Create the app' }}
      </button>
    </mat-dialog-actions>
  `,
})
export class ImportDialog {
  private readonly data = inject<ImportDialogData>(MAT_DIALOG_DATA)
  private readonly ref = inject(MatDialogRef<ImportDialog>)
  readonly adding = !!this.data.existing
  readonly tab = signal(this.data.startTab ?? 0)
  readonly requirements = signal('')
  readonly promptText = computed(() =>
    aiPrompt({
      requirements: this.requirements(),
      existing: this.data.existing,
    }),
  )
  readonly copied = signal(false)
  readonly fixCopied = signal(false)
  readonly json = signal('')
  readonly result = signal<ImportResult | null>(null)
  readonly error = signal('')
  readonly appName = signal('')
  readonly busy = signal(false)
  readonly saveError = signal('')
  readonly pageList = computed(() => {
    const result = this.result()
    if (!result) return ''
    const pages = this.adding
      ? result.project.pages.slice(this.data.existing!.pages.length)
      : result.project.pages
    return pages.map((page) => `${page.name} (/${page.path})`).join(', ')
  })
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer))
  }

  private async copy(
    text: string,
    flag: ReturnType<typeof signal<boolean>>,
  ): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      flag.set(true)
      setTimeout(() => flag.set(false), 2500)
    } catch {
      this.saveError.set(
        'Your browser blocked copying. Open "See the instructions" and copy them from there.',
      )
    }
  }

  copyPrompt(): Promise<void> {
    return this.copy(this.promptText(), this.copied)
  }

  copyFix(): Promise<void> {
    return this.copy(fixPrompt(this.error()), this.fixCopied)
  }

  setJson(value: string): void {
    this.json.set(value)
    this.saveError.set('')
    clearTimeout(this.timer)
    this.timer = setTimeout(() => this.check(), 300)
  }

  async pickFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    if (file.size > 2_000_000) {
      this.error.set('The file is larger than 2 MB.')
      return
    }
    this.json.set(await file.text())
    this.check()
  }

  private check(): void {
    const text = this.json().trim()
    if (!text) {
      this.result.set(null)
      this.error.set('')
      return
    }
    try {
      const result = importJson(text, { existing: this.data.existing })
      this.result.set(result)
      this.error.set('')
      if (!this.adding && !this.appName().trim())
        this.appName.set(result.project.name)
    } catch (error) {
      this.result.set(null)
      this.error.set(
        error instanceof Error ? error.message : 'The JSON could not be read.',
      )
    }
  }

  async save(): Promise<void> {
    const result = this.result()
    if (!result) return
    this.busy.set(true)
    this.saveError.set('')
    try {
      const project = this.adding
        ? result.project
        : { ...result.project, name: this.appName().trim() }
      await this.data.apply(project)
      this.ref.close(project)
    } catch (error) {
      this.saveError.set(
        error instanceof Error ? error.message : 'The app could not be saved.',
      )
    } finally {
      this.busy.set(false)
    }
  }
}

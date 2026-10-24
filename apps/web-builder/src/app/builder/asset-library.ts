import {
  Component,
  computed,
  inject,
  input,
  output,
  signal,
} from '@angular/core'
import { DecimalPipe } from '@angular/common'
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog'
import { MatButtonModule } from '@angular/material/button'
import { MatIconModule } from '@angular/material/icon'
import { MatProgressBarModule } from '@angular/material/progress-bar'
import { MatTooltipModule } from '@angular/material/tooltip'
import { MatButtonToggleModule } from '@angular/material/button-toggle'
import { MatSnackBar } from '@angular/material/snack-bar'
import { ApiService, AssetRecord } from '../services/api'

interface Upload {
  name: string
  progress: number
  error?: string
}

type Kind = 'all' | 'image' | 'video' | 'audio' | 'document'

const kindOf = (type: string): Kind =>
  type.startsWith('image/')
    ? 'image'
    : type.startsWith('video/')
      ? 'video'
      : type.startsWith('audio/')
        ? 'audio'
        : 'document'

/** The project's uploaded files: upload by drag-and-drop or picker, browse, copy links, delete, or pick one. */
@Component({
  selector: 'asset-library',
  imports: [
    DecimalPipe,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    MatTooltipModule,
    MatButtonToggleModule,
  ],
  template: `
    @if (!api.isCloud()) {
      <p class="muted">
        <mat-icon>cloud_off</mat-icon>Connect cloud storage on the projects page
        to upload files.
      </p>
    } @else if (!api.filesEnabled()) {
      <p class="muted">
        <mat-icon>info</mat-icon>File uploads aren't set up on the server yet
        (S3_* settings). See the README.
      </p>
    } @else {
      <label
        class="drop-zone-files"
        [class.over]="dragging()"
        (dragover)="$event.preventDefault(); dragging.set(true)"
        (dragleave)="dragging.set(false)"
        (drop)="drop($event)"
      >
        <mat-icon>cloud_upload</mat-icon>
        <strong>Drop files here or choose</strong>
        <span class="muted"
          >Images, video, audio, PDF and Office files up to 50 MB</span
        >
        <input
          type="file"
          multiple
          class="visually-hidden"
          [attr.accept]="accept()"
          (change)="choose($event)"
        />
      </label>
      @for (upload of uploads(); track upload.name) {
        <div class="upload-row">
          <span>{{ upload.name }}</span>
          @if (upload.error) {
            <span class="logic-result failed">{{ upload.error }}</span>
          } @else {
            <mat-progress-bar
              mode="determinate"
              [value]="upload.progress * 100"
            />
          }
        </div>
      }
      <mat-button-toggle-group
        hideSingleSelectionIndicator
        class="asset-filter"
        [value]="filter()"
        (change)="filter.set($event.value)"
        aria-label="Show files of type"
      >
        <mat-button-toggle value="all">All</mat-button-toggle
        ><mat-button-toggle value="image">Images</mat-button-toggle
        ><mat-button-toggle value="video">Video</mat-button-toggle
        ><mat-button-toggle value="document">Docs</mat-button-toggle>
      </mat-button-toggle-group>
      @if (loading()) {
        <div class="asset-grid">
          @for (n of [1, 2, 3, 4]; track n) {
            <div class="skeleton asset-skeleton"></div>
          }
        </div>
      } @else {
        <div class="asset-grid">
          @for (asset of visible(); track asset.id) {
            <figure class="asset-card" [class.pickable]="picking()">
              <button
                type="button"
                class="asset-preview"
                (click)="pick(asset)"
                [attr.aria-label]="picking() ? 'Use ' + asset.name : asset.name"
                [disabled]="!picking()"
              >
                @if (asset.type.startsWith('image/')) {
                  <img [src]="asset.url" [alt]="asset.name" loading="lazy" />
                } @else {
                  <mat-icon>{{
                    asset.type.startsWith('video/')
                      ? 'movie'
                      : asset.type.startsWith('audio/')
                        ? 'music_note'
                        : 'description'
                  }}</mat-icon>
                }
              </button>
              <figcaption>
                <span class="asset-name" [title]="asset.name">{{
                  asset.name
                }}</span>
                <span class="muted"
                  >{{ asset.size / 1024 | number: '1.0-0' }} KB</span
                >
                <span class="asset-actions">
                  <button
                    mat-icon-button
                    matTooltip="Copy link"
                    [attr.aria-label]="'Copy link to ' + asset.name"
                    (click)="copy(asset)"
                  >
                    <mat-icon>link</mat-icon>
                  </button>
                  <button
                    mat-icon-button
                    matTooltip="Delete"
                    [attr.aria-label]="'Delete ' + asset.name"
                    (click)="remove(asset)"
                  >
                    <mat-icon>delete_outline</mat-icon>
                  </button>
                </span>
              </figcaption>
            </figure>
          } @empty {
            <p class="muted">No files yet.</p>
          }
        </div>
      }
    }
  `,
})
export class AssetLibrary {
  readonly projectId = input.required<string>()
  /** Limit to one kind when picking (e.g. images for an image block). */
  readonly kind = input<Kind>('all')
  readonly picking = input(false)
  readonly picked = output<AssetRecord>()

  readonly api = inject(ApiService)
  private readonly snack = inject(MatSnackBar)
  readonly assets = signal<AssetRecord[]>([])
  readonly loading = signal(true)
  readonly dragging = signal(false)
  readonly uploads = signal<Upload[]>([])
  readonly filter = signal<Kind>('all')
  readonly accept = computed(
    () =>
      ({
        all: '',
        image: 'image/*',
        video: 'video/*',
        audio: 'audio/*',
        document: '.pdf,.csv,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx',
      })[this.kind()] || null,
  )
  readonly visible = computed(() =>
    this.assets().filter(
      (asset) =>
        this.filter() === 'all' || kindOf(asset.type) === this.filter(),
    ),
  )

  ngOnInit(): void {
    if (this.kind() !== 'all') this.filter.set(this.kind())
    void this.load()
  }

  async load(): Promise<void> {
    this.loading.set(true)
    try {
      if ((await this.api.connect()) === 'cloud' && this.api.filesEnabled())
        this.assets.set(await this.api.assets(this.projectId()))
    } catch (error) {
      this.snack.open(
        error instanceof Error ? error.message : 'Files could not be loaded.',
        'Close',
        { duration: 5000 },
      )
    } finally {
      this.loading.set(false)
    }
  }

  drop(event: DragEvent): void {
    event.preventDefault()
    this.dragging.set(false)
    void this.upload([...(event.dataTransfer?.files ?? [])])
  }

  choose(event: Event): void {
    const input = event.target as HTMLInputElement
    void this.upload([...(input.files ?? [])])
    input.value = ''
  }

  private async upload(files: File[]): Promise<void> {
    // Three at a time keeps the browser responsive on large batches.
    const queue = [...files]
    const work = async () => {
      for (let file = queue.shift(); file; file = queue.shift()) {
        const name = file.name
        this.uploads.update((list) => [...list, { name, progress: 0 }])
        const set = (patch: Partial<Upload>) =>
          this.uploads.update((list) =>
            list.map((item) =>
              item.name === name ? { ...item, ...patch } : item,
            ),
          )
        try {
          const asset = await this.api.uploadAsset(
            this.projectId(),
            file,
            (progress) => set({ progress }),
          )
          this.assets.update((list) => [asset, ...list])
          this.uploads.update((list) =>
            list.filter((item) => item.name !== name),
          )
          if (this.picking() && files.length === 1) this.pick(asset)
        } catch (error) {
          set({
            error: error instanceof Error ? error.message : 'Upload failed.',
          })
        }
      }
    }
    await Promise.all([work(), work(), work()])
  }

  pick(asset: AssetRecord): void {
    if (this.picking()) this.picked.emit(asset)
  }

  async copy(asset: AssetRecord): Promise<void> {
    const link = new URL(asset.url, location.origin).toString()
    try {
      await navigator.clipboard.writeText(link)
      this.snack.open('Link copied.', 'Close', { duration: 2000 })
    } catch {
      this.snack.open(link, 'Close', { duration: 8000 })
    }
  }

  async remove(asset: AssetRecord): Promise<void> {
    if (
      !confirm(`Delete ${asset.name}? Pages using it will show a broken link.`)
    )
      return
    try {
      await this.api.deleteAsset(this.projectId(), asset.id)
      this.assets.update((list) => list.filter((item) => item.id !== asset.id))
    } catch (error) {
      this.snack.open(
        error instanceof Error ? error.message : 'Could not delete the file.',
        'Close',
        { duration: 5000 },
      )
    }
  }
}

/** Dialog wrapper so URL fields can pick an uploaded file. */
@Component({
  selector: 'asset-picker',
  imports: [AssetLibrary, MatDialogModule, MatButtonModule],
  template: `
    <h2 mat-dialog-title>Choose a file</h2>
    <mat-dialog-content
      ><asset-library
        [projectId]="data.projectId"
        [kind]="data.kind"
        [picking]="true"
        (picked)="ref.close($event.url)"
    /></mat-dialog-content>
    <mat-dialog-actions align="end"
      ><button mat-button mat-dialog-close>Cancel</button></mat-dialog-actions
    >
  `,
})
export class AssetPicker {
  readonly data = inject<{ projectId: string; kind: Kind }>(MAT_DIALOG_DATA)
  readonly ref = inject(MatDialogRef<AssetPicker, string>)
}

export const kindForBlock = (type: string): Kind =>
  type === 'image' ||
  type === 'hero' ||
  type === 'avatar' ||
  type === 'gallery' ||
  type === 'carousel'
    ? 'image'
    : type === 'video'
      ? 'video'
      : type === 'audio'
        ? 'audio'
        : 'all'

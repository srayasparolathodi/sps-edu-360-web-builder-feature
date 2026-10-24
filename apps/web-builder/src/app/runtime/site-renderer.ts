import {
  Component,
  DestroyRef,
  effect,
  inject,
  input,
  untracked,
} from '@angular/core'
import { DOCUMENT } from '@angular/common'
import { MatIconModule } from '@angular/material/icon'
import { MatButtonModule } from '@angular/material/button'
import { Project, blockCss } from '@spsedu360/engine/model'
import { LiveBlocks } from './live-blocks'
import { SiteSignIn } from './sign-in'
import { ANONYMOUS, Visitor } from '@spsedu360/engine/access'
import { RuntimeService } from './runtime'

/** Renders one project live. Each instance has its own variables and flow state. */
@Component({
  selector: 'site-renderer',
  imports: [LiveBlocks, SiteSignIn, MatIconModule, MatButtonModule],
  providers: [RuntimeService],
  template: `
    @if (runtime.page(); as page) {
      @if (page.locked) {
        <main class="published-page locked-page" [attr.aria-label]="page.name">
          <div class="locked-head">
            <mat-icon>lock</mat-icon>
            <h2>
              {{
                runtime.user().signedIn
                  ? "You don't have access to this page"
                  : 'Sign in to see this page'
              }}
            </h2>
          </div>
          @if (!runtime.user().signedIn) {
            <site-sign-in
              [allowSignUp]="project().auth?.allowSignUp ?? true"
              [live]="!draft()"
            />
          } @else {
            <p class="muted">
              Ask the site's administrator to give your account access.
            </p>
          }
        </main>
      } @else {
        <main class="published-page" [attr.aria-label]="page.name">
          <live-blocks [blocks]="page.blocks" />
        </main>
      }
    } @else {
      <div class="state-card state-empty page-missing" role="status">
        <mat-icon>travel_explore</mat-icon>
        <div>
          <strong>Page not found</strong
          ><span>No page matches “/{{ path() }}”.</span>
        </div>
        <button
          mat-stroked-button
          type="button"
          (click)="runtime.navigate('/')"
        >
          <mat-icon>home</mat-icon>Go to home page
        </button>
      </div>
    }
  `,
})
export class SiteRenderer {
  readonly project = input.required<Project>()
  readonly path = input('')
  readonly query = input<Record<string, string>>({})
  /** True in the builder preview: server flows run against the unsaved draft. */
  readonly draft = input(false)
  /** URL prefix for internal links, e.g. /site/<id>. */
  readonly base = input('')
  /** Builder preview handles navigation itself. */
  readonly onNavigate = input<((path: string) => void) | null>(null)
  /** Who is visiting: from the server session, or chosen in the builder's "Preview as". */
  readonly visitor = input<Visitor>(ANONYMOUS)
  /** Called after signing in or out on a live site. */
  readonly onAuthChange = input<(() => void) | null>(null)

  readonly runtime = inject(RuntimeService)
  private readonly document = inject(DOCUMENT)
  private readonly sheet = this.document.createElement('style')
  /** Path and query last opened, so each navigation runs page flows once. */
  private opened = ''

  constructor() {
    this.document.head.appendChild(this.sheet)
    effect(() => {
      const project = this.project()
      const draft = this.draft()
      untracked(() => {
        this.runtime.base.set(this.base())
        this.runtime.navigateHook.set(this.onNavigate())
        this.runtime.authHook.set(this.onAuthChange())
        this.runtime.user.set(this.visitor())
        this.runtime.load(project, draft)
        this.runtime.open(this.path(), this.query())
        this.opened = `${this.path()}?${JSON.stringify(this.query())}`
      })
    })
    effect(() => {
      const visitor = this.visitor()
      untracked(() => this.runtime.user.set(visitor))
    })
    // Navigation within the same project; skips the open the effect above just did.
    effect(() => {
      const key = `${this.path()}?${JSON.stringify(this.query())}`
      untracked(() => {
        if (key === this.opened || !this.runtime.project()) return
        this.opened = key
        this.runtime.open(this.path(), this.query())
      })
    })
    effect(() => {
      const page = this.runtime.page()
      this.sheet.textContent = page ? page.blocks.map(blockCss).join('') : ''
    })
    inject(DestroyRef).onDestroy(() => {
      this.runtime.cancelAll()
      this.runtime.stopClock()
      this.sheet.remove()
    })
  }
}

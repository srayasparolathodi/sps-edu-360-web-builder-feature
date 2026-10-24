import { Component, DestroyRef, inject, signal } from '@angular/core'
import { provideCharts, withDefaultRegisterables } from 'ng2-charts'
import { DOCUMENT } from '@angular/common'
import {
  ActivatedRoute,
  NavigationEnd,
  Router,
  RouterLink,
} from '@angular/router'
import { MatButtonModule } from '@angular/material/button'
import { MatIconModule } from '@angular/material/icon'
import { filter } from 'rxjs'
import { Project } from '@spsedu360/engine/model'
import { ANONYMOUS, Visitor } from '@spsedu360/engine/access'
import { ApiService } from '../services/api'
import { SiteRenderer } from './site-renderer'

/** Public routes: /<slug>/<page path…> and the older /site/:projectId/<page path…>. */
@Component({
  selector: 'site-page',
  // Chart.js loads only with the pages that can show charts.
  providers: [provideCharts(withDefaultRegisterables())],
  imports: [SiteRenderer, MatButtonModule, MatIconModule, RouterLink],
  template: `
    @if (project(); as project) {
      <site-renderer
        [project]="project"
        [path]="path()"
        [query]="query()"
        [base]="base()"
        [visitor]="visitor()"
        [onAuthChange]="reload"
      />
    } @else if (error()) {
      <div class="state-card state-error page-missing" role="alert">
        <mat-icon>cloud_off</mat-icon>
        <div>
          <strong>This site isn't available</strong><span>{{ error() }}</span>
        </div>
        <button mat-stroked-button type="button" (click)="load()">
          <mat-icon>refresh</mat-icon>Try again
        </button>
        <a mat-button routerLink="/">Open Page Studio</a>
      </div>
    } @else {
      <div
        class="published-page page-skeleton"
        aria-busy="true"
        aria-label="Loading site"
      >
        <div class="skeleton skeleton-bar"></div>
        <div class="skeleton skeleton-hero"></div>
        <div class="skeleton-grid">
          @for (n of [1, 2, 3]; track n) {
            <div class="skeleton skeleton-card"></div>
          }
        </div>
        @for (n of [1, 2, 3, 4]; track n) {
          <div
            class="skeleton skeleton-line"
            [style.width.%]="96 - n * 14"
          ></div>
        }
      </div>
    }
  `,
})
export class SitePage {
  private readonly api = inject(ApiService)
  private readonly route = inject(ActivatedRoute)
  private readonly router = inject(Router)
  private readonly document = inject(DOCUMENT)
  readonly project = signal<Project | null>(null)
  readonly error = signal('')
  readonly path = signal('')
  readonly query = signal<Record<string, string>>({})
  readonly visitor = signal<Visitor>(ANONYMOUS)
  /** URL prefix of this site: /<slug> or /site/<id>. */
  readonly base = signal('')
  /** After sign-in/out: fetch the site again, since what the visitor may see changed. */
  readonly reload = () => void this.load()

  constructor() {
    this.readUrl()
    const subscription = this.router.events
      .pipe(filter((event) => event instanceof NavigationEnd))
      .subscribe(() => this.readUrl())
    inject(DestroyRef).onDestroy(() => subscription.unsubscribe())
    void this.load()
  }

  /** Which site this URL names: by web address, or by id on the older /site/<id> links. */
  private key(): { key: string; bySlug: boolean } {
    const slug = this.route.snapshot.paramMap.get('slug')
    return slug
      ? { key: slug, bySlug: true }
      : {
          key: this.route.snapshot.paramMap.get('projectId') ?? '',
          bySlug: false,
        }
  }

  private loadedKey = ''

  private readUrl(): void {
    const { key, bySlug } = this.key()
    const url = this.router.parseUrl(this.router.url)
    const segments =
      url.root.children['primary']?.segments.map((segment) => segment.path) ??
      []
    // Drop "<slug>" or "site/<id>"; the rest is the page path, matched only within this site.
    this.path.set(segments.slice(bySlug ? 1 : 2).join('/'))
    this.base.set(bySlug ? `/${key}` : `/site/${key}`)
    this.query.set(
      Object.fromEntries(
        Object.entries(url.queryParams).map(([name, value]) => [
          name,
          String(value),
        ]),
      ),
    )
    if (this.loadedKey && this.loadedKey !== key) void this.load()
  }

  async load(): Promise<void> {
    const { key, bySlug } = this.key()
    this.loadedKey = key
    this.error.set('')
    this.project.set(null)
    try {
      const [project, visitor] = await Promise.all([
        this.api.site(key, bySlug),
        this.api.visitor(key, bySlug),
      ])
      this.visitor.set(visitor)
      this.project.set(project)
      this.document.title = project.name
      this.document.documentElement.classList.toggle('dark-theme', project.dark)
    } catch (error) {
      this.error.set(
        error instanceof Error && /not found/i.test(error.message)
          ? 'It has not been published yet, or the link is wrong.'
          : error instanceof Error
            ? error.message
            : 'Please try again.',
      )
    }
  }
}

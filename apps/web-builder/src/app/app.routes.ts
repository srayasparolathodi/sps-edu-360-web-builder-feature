import { inject } from '@angular/core'
import { Router, Routes } from '@angular/router'
import { ApiService } from './services/api'
import { LandingPage } from './landing/landing'

export const routes: Routes = [
  { path: '', component: LandingPage, title: 'Page Studio' },
  {
    path: 'builder/:projectId',
    // The Worker that serves published apps has no builder.
    canActivate: [
      () => {
        const api = inject(ApiService)
        const router = inject(Router)
        return api
          .connect()
          .then(() =>
            api.serverMode() === 'sites' ? router.parseUrl('/') : true,
          )
      },
    ],
    loadComponent: () =>
      import('./builder/builder-page').then((m) => m.BuilderPage),
  },
  {
    // Published sites; everything after the id is the page path.
    path: 'site/:projectId',
    children: [
      {
        path: '**',
        loadComponent: () =>
          import('./runtime/site-page').then((m) => m.SitePage),
      },
    ],
  },
  {
    // Published sites by web address: /<slug>/<page path…>?<query>. Reserved words never reach here.
    path: ':slug',
    children: [
      {
        path: '**',
        loadComponent: () =>
          import('./runtime/site-page').then((m) => m.SitePage),
      },
    ],
  },
  { path: '**', redirectTo: '' },
]

import { Routes } from '@angular/router'
import { LandingPage } from './landing/landing'

export const routes: Routes = [
  { path: '', component: LandingPage, title: 'Page Studio' },
  {
    path: 'builder/:projectId',
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

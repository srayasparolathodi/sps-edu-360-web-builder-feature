import { inject, provideAppInitializer } from '@angular/core'
import { bootstrapApplication } from '@angular/platform-browser'
import {
  provideRouter,
  withInMemoryScrolling,
  withRouterConfig,
} from '@angular/router'
import { MatIconRegistry } from '@angular/material/icon'
import { AppComponent } from './app/app'
import { routes } from './app/app.routes'

bootstrapApplication(AppComponent, {
  providers: [
    provideRouter(
      routes,
      withInMemoryScrolling({ scrollPositionRestoration: 'top' }),
      // /site/:projectId/** pages read the project id from the parent route.
      withRouterConfig({ paramsInheritanceStrategy: 'always' }),
    ),
    // Rounded Material Symbols match the softer, modern look.
    provideAppInitializer(() => {
      inject(MatIconRegistry).setDefaultFontSetClass('material-symbols-rounded')
    }),
  ],
}).catch(console.error)

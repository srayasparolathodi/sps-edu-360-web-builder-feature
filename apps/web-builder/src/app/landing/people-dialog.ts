import { Component, inject, signal } from '@angular/core'
import { DatePipe } from '@angular/common'
import { MatDialogModule } from '@angular/material/dialog'
import { MatButtonModule } from '@angular/material/button'
import { MatIconModule } from '@angular/material/icon'
import { MatSelectModule } from '@angular/material/select'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner'
import { ApiService, BuilderUser } from '../services/api'

/** Admins: everyone who has signed in to Page Studio, and whether they are an admin or an author. */
@Component({
  selector: 'people-dialog',
  imports: [
    DatePipe,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatSelectModule,
    MatFormFieldModule,
    MatProgressSpinnerModule,
  ],
  template: `
    <h2 mat-dialog-title>People</h2>
    <mat-dialog-content class="versions-dialog">
      <p class="muted">
        People appear here after they open Page Studio through Cloudflare
        Access. Authors build and manage one app of their own; admins can open
        and change every app.
      </p>
      @if (error()) {
        <p class="logic-result failed" role="alert">
          <mat-icon>error_outline</mat-icon>{{ error() }}
        </p>
      }
      @if (users() === null) {
        <div class="version-loading"><mat-spinner diameter="24" /></div>
      } @else {
        <ul class="version-list">
          @for (person of users(); track person.id) {
            <li class="version-row">
              <span class="monogram small">{{
                (person.email || '?')[0].toUpperCase()
              }}</span>
              <div class="version-text">
                <strong>{{ person.email }}</strong
                ><span class="muted"
                  >Joined {{ person.createdAt | date: 'mediumDate'
                  }}{{ person.id === api.user()?.id ? ' · you' : '' }}</span
                >
              </div>
              <mat-form-field
                appearance="outline"
                class="member-role"
                subscriptSizing="dynamic"
              >
                <mat-select
                  [value]="person.role"
                  [disabled]="person.id === api.user()?.id"
                  (selectionChange)="setRole(person, $event.value)"
                  [attr.aria-label]="'Role for ' + person.email"
                >
                  <mat-option value="author">Author</mat-option
                  ><mat-option value="admin">Admin</mat-option>
                </mat-select>
              </mat-form-field>
            </li>
          } @empty {
            <li class="muted">Nobody has signed in yet.</li>
          }
        </ul>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end"
      ><button mat-button mat-dialog-close>Close</button></mat-dialog-actions
    >
  `,
})
export class PeopleDialog {
  readonly api = inject(ApiService)
  readonly users = signal<(BuilderUser & { createdAt: string })[] | null>(null)
  readonly error = signal('')

  constructor() {
    void this.load()
  }

  private async load(): Promise<void> {
    try {
      this.users.set(await this.api.users())
    } catch (error) {
      this.users.set([])
      this.error.set(
        error instanceof Error ? error.message : 'People could not be loaded.',
      )
    }
  }

  async setRole(person: BuilderUser, role: 'admin' | 'author'): Promise<void> {
    try {
      await this.api.setUserRole(person.id, role)
      await this.load()
    } catch (error) {
      this.error.set(
        error instanceof Error
          ? error.message
          : 'The role could not be changed.',
      )
    }
  }
}

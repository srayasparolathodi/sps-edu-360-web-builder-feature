import { Component, inject, input, signal } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { MatButtonModule } from '@angular/material/button'
import { MatIconModule } from '@angular/material/icon'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatInputModule } from '@angular/material/input'
import { MatButtonToggleModule } from '@angular/material/button-toggle'
import { ApiService } from '../services/api'
import { RuntimeService } from './runtime'

/** Sign in, create an account, or sign out — for visitors of published sites. */
@Component({
  selector: 'site-sign-in',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatButtonToggleModule,
  ],
  template: `
    @let user = runtime?.user();
    <div class="sign-in-card">
      @if (user?.signedIn) {
        <div class="signed-in">
          <span class="monogram small">{{
            (user!.name || user!.email || '?')[0].toUpperCase()
          }}</span>
          <div>
            <strong>{{ user!.name || user!.email }}</strong
            ><span class="muted">{{
              user!.roles.length ? user!.roles.join(', ') : 'No role yet'
            }}</span>
          </div>
          <button
            mat-stroked-button
            type="button"
            [disabled]="busy() || !live()"
            (click)="signOut()"
          >
            <mat-icon>logout</mat-icon>Sign out
          </button>
        </div>
      } @else {
        @if (heading()) {
          <h3>{{ heading() }}</h3>
        }
        @if (allowSignUp()) {
          <mat-button-toggle-group
            hideSingleSelectionIndicator
            [value]="mode()"
            (change)="mode.set($event.value); error.set('')"
            aria-label="Sign in or create an account"
          >
            <mat-button-toggle value="sign-in">Sign in</mat-button-toggle
            ><mat-button-toggle value="sign-up"
              >Create account</mat-button-toggle
            >
          </mat-button-toggle-group>
        }
        <form (submit)="submit($event)" novalidate>
          @if (mode() === 'sign-up') {
            <mat-form-field appearance="outline"
              ><mat-label>Your name</mat-label
              ><input
                matInput
                name="name"
                autocomplete="name"
                [(ngModel)]="name"
            /></mat-form-field>
          }
          <mat-form-field appearance="outline"
            ><mat-label>Email</mat-label
            ><input
              matInput
              name="email"
              type="email"
              autocomplete="email"
              required
              [(ngModel)]="email"
          /></mat-form-field>
          <mat-form-field appearance="outline"
            ><mat-label>Password</mat-label
            ><input
              matInput
              name="password"
              type="password"
              [autocomplete]="
                mode() === 'sign-up' ? 'new-password' : 'current-password'
              "
              required
              minlength="8"
              [(ngModel)]="password"
            />
            @if (mode() === 'sign-up') {
              <mat-hint>At least 8 characters</mat-hint>
            }
          </mat-form-field>
          @if (error()) {
            <p class="logic-result failed" role="alert">
              <mat-icon>error_outline</mat-icon>{{ error() }}
            </p>
          }
          <button mat-flat-button type="submit" [disabled]="busy() || !live()">
            {{
              busy()
                ? 'Please wait…'
                : mode() === 'sign-up'
                  ? 'Create account'
                  : 'Sign in'
            }}
          </button>
          @if (!live()) {
            <p class="muted">Sign-in works on the published site.</p>
          }
        </form>
      }
    </div>
  `,
})
export class SiteSignIn {
  readonly heading = input('')
  readonly allowSignUp = input(true)
  readonly live = input(true)
  readonly runtime = inject(RuntimeService, { optional: true })
  private readonly api = inject(ApiService)
  readonly mode = signal<'sign-in' | 'sign-up'>('sign-in')
  readonly busy = signal(false)
  readonly error = signal('')
  name = ''
  email = ''
  password = ''

  async submit(event: Event): Promise<void> {
    event.preventDefault()
    if (!this.email || this.password.length < 8) {
      this.error.set(
        'Enter your email and a password of at least 8 characters.',
      )
      return
    }
    this.busy.set(true)
    const problem = await this.api.visitorAuth(this.mode(), {
      email: this.email,
      password: this.password,
      name: this.name,
    })
    this.busy.set(false)
    this.error.set(problem)
    if (!problem) {
      this.password = ''
      this.runtime?.authChanged()
    }
  }

  async signOut(): Promise<void> {
    this.busy.set(true)
    await this.api.visitorAuth('sign-out')
    this.busy.set(false)
    this.runtime?.authChanged()
  }
}

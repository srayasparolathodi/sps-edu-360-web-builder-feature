import { Component, computed, inject, signal } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { NgTemplateOutlet } from '@angular/common'
import {
  MAT_DIALOG_DATA,
  MatDialogModule,
  MatDialogRef,
} from '@angular/material/dialog'
import { MatButtonModule } from '@angular/material/button'
import { MatIconModule } from '@angular/material/icon'
import { MatFormFieldModule } from '@angular/material/form-field'
import { MatInputModule } from '@angular/material/input'
import { MatSelectModule } from '@angular/material/select'
import { MatSlideToggleModule } from '@angular/material/slide-toggle'
import { MatCheckboxModule } from '@angular/material/checkbox'
import { MatExpansionModule } from '@angular/material/expansion'
import { MatProgressSpinnerModule } from '@angular/material/progress-spinner'
import { Project } from '@spsedu360/engine/model'
import {
  AUTH_TYPES,
  ApiAuth,
  ApiDef,
  ApiParam,
  AuthType,
  ParamPlace,
  placeholders,
  validateApi,
} from '@spsedu360/engine/api'
import { AccessRule } from '@spsedu360/engine/access'
import { Logic } from '@spsedu360/engine/logic'
import { LogicField } from '../logic/logic-editor'
import { ApiService, ApiTestResult } from '../services/api'

export interface ApiEditorData {
  api: ApiDef
  project: Project
  /** Credential names saved for this app (values never come to the browser). */
  secretNames: string[]
  /** Flows that call this API, shown before deleting. */
  usedBy: string[]
  save: (api: ApiDef) => void
  remove?: () => void
}

/** Create or change one of the app's saved APIs, and try it out. */
@Component({
  selector: 'api-editor',
  imports: [
    FormsModule,
    NgTemplateOutlet,
    MatDialogModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatSlideToggleModule,
    MatCheckboxModule,
    MatExpansionModule,
    MatProgressSpinnerModule,
    LogicField,
  ],
  template: `
    <h2 mat-dialog-title>{{ isNew ? 'New API' : api().name }}</h2>
    <mat-dialog-content class="api-editor">
      <div class="inline-fields">
        <mat-form-field appearance="outline"
          ><mat-label>Name</mat-label
          ><input
            matInput
            [ngModel]="api().name"
            (ngModelChange)="set('name', $event)"
            placeholder="Get student"
        /></mat-form-field>
        <mat-form-field appearance="outline"
          ><mat-label>Available on</mat-label>
          <mat-select
            [value]="api().pageId ?? ''"
            (selectionChange)="set('pageId', $event.value || undefined)"
          >
            <mat-option value="">The whole app (every page)</mat-option>
            @for (page of data.project.pages; track page.id) {
              <mat-option [value]="page.id"
                >Only the page “{{ page.name }}”</mat-option
              >
            }
          </mat-select>
        </mat-form-field>
      </div>
      <mat-form-field appearance="outline" class="full-width"
        ><mat-label>What it does (optional)</mat-label
        ><input
          matInput
          [ngModel]="api().description"
          (ngModelChange)="set('description', $event)"
      /></mat-form-field>

      <h3 class="panel-title">Request</h3>
      <div class="inline-fields method-url">
        <mat-form-field appearance="outline" class="method-field"
          ><mat-label>Method</mat-label>
          <mat-select
            [value]="api().method"
            (selectionChange)="set('method', $event.value)"
          >
            @for (m of methods; track m) {
              <mat-option [value]="m">{{ m }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field appearance="outline"
          ><mat-label>Address</mat-label
          ><input
            matInput
            spellcheck="false"
            [ngModel]="api().url"
            (ngModelChange)="setUrl($event)"
            placeholder="https://api.school.edu/v1/students/{studentId}"
          />
          <mat-hint
            >Put changing parts in braces, e.g. {{ '{' }}studentId{{ '}' }}:
            they become path parameters.</mat-hint
          >
        </mat-form-field>
      </div>

      <h3 class="panel-title">
        Parameters
        <span class="muted"
          >— values each call provides (from forms, other steps, variables, the
          page address…)</span
        >
      </h3>
      @for (param of api().params; track $index; let i = $index) {
        <div class="param-row">
          <mat-form-field appearance="outline" subscriptSizing="dynamic"
            ><mat-label>Name</mat-label
            ><input
              matInput
              [ngModel]="param.name"
              (ngModelChange)="setParam(i, { name: $event })"
          /></mat-form-field>
          <mat-form-field
            appearance="outline"
            subscriptSizing="dynamic"
            class="place-field"
            ><mat-label>Sent in</mat-label>
            <mat-select
              [value]="param.in"
              (selectionChange)="setParam(i, { in: $event.value })"
            >
              @for (place of places; track place.value) {
                <mat-option [value]="place.value">{{ place.label }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field appearance="outline" subscriptSizing="dynamic"
            ><mat-label>Default</mat-label
            ><input
              matInput
              [ngModel]="text(param.default)"
              (ngModelChange)="
                setParam(i, { default: $event === '' ? undefined : $event })
              "
          /></mat-form-field>
          <mat-checkbox
            [checked]="param.required"
            (change)="setParam(i, { required: $event.checked })"
            >Required</mat-checkbox
          >
          <button
            mat-icon-button
            type="button"
            [attr.aria-label]="'Remove ' + param.name"
            (click)="removeParam(i)"
          >
            <mat-icon>delete_outline</mat-icon>
          </button>
        </div>
      }
      <button mat-stroked-button type="button" (click)="addParam()">
        <mat-icon>add</mat-icon>Add parameter
      </button>

      <mat-expansion-panel class="api-section">
        <mat-expansion-panel-header
          ><mat-panel-title
            >Headers and body</mat-panel-title
          ></mat-expansion-panel-header
        >
        @for (header of headerList(); track $index; let i = $index) {
          <div class="param-row">
            <mat-form-field appearance="outline" subscriptSizing="dynamic"
              ><mat-label>Header</mat-label
              ><input
                matInput
                [ngModel]="header[0]"
                (ngModelChange)="setHeader(i, $event, header[1])"
            /></mat-form-field>
            <mat-form-field appearance="outline" subscriptSizing="dynamic"
              ><mat-label>Value</mat-label
              ><input
                matInput
                [ngModel]="header[1]"
                (ngModelChange)="setHeader(i, header[0], $event)"
            /></mat-form-field>
            <button
              mat-icon-button
              type="button"
              aria-label="Remove header"
              (click)="removeHeader(i)"
            >
              <mat-icon>delete_outline</mat-icon>
            </button>
          </div>
        }
        <button mat-button type="button" (click)="addHeader()">
          <mat-icon>add</mat-icon>Add a fixed header
        </button>
        @if (api().method !== 'GET') {
          <mat-form-field appearance="outline" class="full-width"
            ><mat-label>Body format</mat-label>
            <mat-select
              [value]="api().bodyType"
              (selectionChange)="set('bodyType', $event.value)"
            >
              <mat-option value="json">JSON</mat-option
              ><mat-option value="form">Form (x-www-form-urlencoded)</mat-option
              ><mat-option value="text">Plain text</mat-option
              ><mat-option value="none">No body</mat-option>
            </mat-select>
            <mat-hint
              >By default the "body" parameters are sent as one
              object.</mat-hint
            >
          </mat-form-field>
          @if (api().bodyType !== 'none') {
            <logic-field
              label="Body shape (optional)"
              hint="Only if the API needs a nested shape. Use args.<parameter>."
              [value]="api().body"
              [variables]="argVariables()"
              (valueChange)="set('body', $event)"
            />
          }
        }
        <mat-form-field appearance="outline" class="full-width"
          ><mat-label>Answer format</mat-label>
          <mat-select
            [value]="api().responseType"
            (selectionChange)="set('responseType', $event.value)"
            ><mat-option value="json">JSON</mat-option
            ><mat-option value="text">Text</mat-option></mat-select
          >
        </mat-form-field>
      </mat-expansion-panel>

      <h3 class="panel-title">Authorization</h3>
      <mat-form-field appearance="outline" class="full-width"
        ><mat-label>Type</mat-label>
        <mat-select
          [value]="api().auth.type"
          (selectionChange)="setAuthType($event.value)"
        >
          @for (type of authTypes; track type.type) {
            <mat-option [value]="type.type">{{ type.label }}</mat-option>
          }
        </mat-select>
        <mat-hint>{{ authInfo()?.description }}</mat-hint>
      </mat-form-field>
      @switch (api().auth.type) {
        @case ('apiKey') {
          <div class="inline-fields">
            <mat-form-field appearance="outline"
              ><mat-label>Key name</mat-label
              ><input
                matInput
                [ngModel]="api().auth.keyName"
                (ngModelChange)="setAuth({ keyName: $event })"
                placeholder="X-API-Key"
            /></mat-form-field>
            <mat-form-field appearance="outline"
              ><mat-label>Sent in</mat-label
              ><mat-select
                [value]="api().auth.keyIn ?? 'header'"
                (selectionChange)="setAuth({ keyIn: $event.value })"
                ><mat-option value="header">A header</mat-option
                ><mat-option value="query"
                  >The address (?key=)</mat-option
                ></mat-select
              ></mat-form-field
            >
          </div>
          <ng-container
            *ngTemplateOutlet="
              secretPicker;
              context: { field: 'secret', label: 'Credential with the key' }
            "
          />
        }
        @case ('bearer') {
          <mat-form-field appearance="outline" class="full-width"
            ><mat-label>Token comes from</mat-label>
            <mat-select
              [value]="api().auth.token !== undefined ? 'step' : 'secret'"
              (selectionChange)="setTokenSource($event.value)"
            >
              <mat-option value="secret">A saved credential</mat-option
              ><mat-option value="step"
                >Each call (e.g. a token from a login step)</mat-option
              >
            </mat-select>
          </mat-form-field>
          @if (api().auth.token !== undefined) {
            <logic-field
              label="Token"
              hint="Usually args.token: add a 'token' parameter and pass the login step's token to it."
              [optional]="false"
              [value]="api().auth.token"
              [variables]="argVariables()"
              (valueChange)="
                setAuth({ token: $event ?? { var: 'args.token' } })
              "
            />
          } @else {
            <ng-container
              *ngTemplateOutlet="
                secretPicker;
                context: { field: 'secret', label: 'Credential with the token' }
              "
            />
          }
        }
        @case ('basic') {
          <ng-container
            *ngTemplateOutlet="
              secretPicker;
              context: {
                field: 'username',
                label: 'Credential with the user name',
              }
            "
          />
          <ng-container
            *ngTemplateOutlet="
              secretPicker;
              context: {
                field: 'password',
                label: 'Credential with the password',
              }
            "
          />
        }
        @case ('oauth2') {
          <mat-form-field appearance="outline" class="full-width"
            ><mat-label>Token address</mat-label
            ><input
              matInput
              [ngModel]="api().auth.tokenUrl"
              (ngModelChange)="setAuth({ tokenUrl: $event })"
              placeholder="https://auth.example.com/oauth/token"
          /></mat-form-field>
          <ng-container
            *ngTemplateOutlet="
              secretPicker;
              context: {
                field: 'clientId',
                label: 'Credential with the client id',
              }
            "
          />
          <ng-container
            *ngTemplateOutlet="
              secretPicker;
              context: {
                field: 'clientSecret',
                label: 'Credential with the client secret',
              }
            "
          />
          <div class="inline-fields">
            <mat-form-field appearance="outline"
              ><mat-label>Scope (optional)</mat-label
              ><input
                matInput
                [ngModel]="api().auth.scope"
                (ngModelChange)="setAuth({ scope: $event || undefined })"
            /></mat-form-field>
            <mat-form-field appearance="outline"
              ><mat-label>Audience (optional)</mat-label
              ><input
                matInput
                [ngModel]="api().auth.audience"
                (ngModelChange)="setAuth({ audience: $event || undefined })"
            /></mat-form-field>
          </div>
          <mat-form-field appearance="outline" class="full-width"
            ><mat-label>Client sends its credentials</mat-label
            ><mat-select
              [value]="api().auth.clientAuth ?? 'body'"
              (selectionChange)="setAuth({ clientAuth: $event.value })"
              ><mat-option value="body">In the request body</mat-option
              ><mat-option value="basic"
                >As Basic authorization</mat-option
              ></mat-select
            ></mat-form-field
          >
          <p class="muted">
            The token is fetched once and reused until it expires.
          </p>
        }
        @case ('hmac') {
          <ng-container
            *ngTemplateOutlet="
              secretPicker;
              context: {
                field: 'secret',
                label: 'Credential with the signing secret',
              }
            "
          />
          <div class="inline-fields">
            <mat-form-field appearance="outline"
              ><mat-label>Signature header</mat-label
              ><input
                matInput
                [ngModel]="api().auth.hmacHeader"
                (ngModelChange)="setAuth({ hmacHeader: $event })"
                placeholder="X-Signature"
            /></mat-form-field>
            <mat-form-field appearance="outline"
              ><mat-label>Prefix (optional)</mat-label
              ><input
                matInput
                [ngModel]="api().auth.hmacPrefix"
                (ngModelChange)="setAuth({ hmacPrefix: $event || undefined })"
                placeholder="sha256="
            /></mat-form-field>
          </div>
          <div class="inline-fields">
            <mat-form-field appearance="outline"
              ><mat-label>Algorithm</mat-label
              ><mat-select
                [value]="api().auth.hmacAlgorithm ?? 'SHA-256'"
                (selectionChange)="setAuth({ hmacAlgorithm: $event.value })"
                ><mat-option value="SHA-256">SHA-256</mat-option
                ><mat-option value="SHA-512">SHA-512</mat-option
                ><mat-option value="SHA-1">SHA-1</mat-option></mat-select
              ></mat-form-field
            >
            <mat-form-field appearance="outline"
              ><mat-label>Encoding</mat-label
              ><mat-select
                [value]="api().auth.hmacEncoding ?? 'hex'"
                (selectionChange)="setAuth({ hmacEncoding: $event.value })"
                ><mat-option value="hex">Hex</mat-option
                ><mat-option value="base64">Base64</mat-option></mat-select
              ></mat-form-field
            >
          </div>
          <mat-form-field appearance="outline" class="full-width"
            ><mat-label>Timestamp header (optional)</mat-label
            ><input
              matInput
              [ngModel]="api().auth.hmacTimestampHeader"
              (ngModelChange)="
                setAuth({ hmacTimestampHeader: $event || undefined })
              "
              placeholder="X-Timestamp"
          /></mat-form-field>
          <logic-field
            label="What is signed (optional)"
            hint="Defaults to the body. Available: method, path, query, body, timestamp, args."
            [value]="api().auth.hmacMessage"
            [variables]="['method', 'path', 'query', 'body', 'timestamp']"
            (valueChange)="setAuth({ hmacMessage: $event })"
          />
        }
        @case ('custom') {
          <logic-field
            label="Headers"
            hint="Data with one field per header. Use secrets.NAME for credentials and args.<parameter> for call values."
            [optional]="false"
            [value]="api().auth.headers"
            [variables]="argVariables()"
            (valueChange)="setAuth({ headers: $event ?? {} })"
          />
        }
      }
      <ng-template #secretPicker let-field="field" let-label="label">
        <mat-form-field appearance="outline" class="full-width"
          ><mat-label>{{ label }}</mat-label>
          <mat-select
            [value]="$any(api().auth)[field] ?? ''"
            (selectionChange)="setAuthField(field, $event.value)"
          >
            @for (name of data.secretNames; track name) {
              <mat-option [value]="name">{{ name }}</mat-option>
            }
          </mat-select>
          <mat-hint>{{
            data.secretNames.length
              ? 'Values stay on the server.'
              : 'Save the value first on the Data tab → Credentials.'
          }}</mat-hint>
        </mat-form-field>
      </ng-template>

      <h3 class="panel-title">Who can use it</h3>
      <mat-slide-toggle
        [checked]="api().browser"
        (change)="set('browser', $event.checked)"
        >Pages can call it (through the server; credentials stay
        hidden)</mat-slide-toggle
      >
      @if (!api().browser) {
        <p class="muted">
          Only server journeys can call it, e.g. when it changes data or must
          not be reachable from a browser.
        </p>
      }
      @if (data.project.auth?.enabled) {
        <mat-form-field appearance="outline" class="full-width"
          ><mat-label>Who can call it</mat-label>
          <mat-select
            multiple
            [value]="accessChoice()"
            (selectionChange)="setAccess($event.value)"
          >
            <mat-option value="public">Everyone</mat-option
            ><mat-option value="signedIn">Anyone signed in</mat-option>
            @for (role of data.project.auth!.roles; track role.id) {
              <mat-option [value]="role.id">{{ role.name }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
      }

      <h3 class="panel-title">Try it</h3>
      @for (param of api().params; track param.name) {
        <mat-form-field
          appearance="outline"
          class="full-width"
          subscriptSizing="dynamic"
          ><mat-label
            >{{ param.name }}{{ param.required ? ' *' : '' }}</mat-label
          ><input
            matInput
            [ngModel]="text(sample()[param.name])"
            (ngModelChange)="setSample(param.name, $event)"
            [placeholder]="text(param.default)"
        /></mat-form-field>
      }
      <button
        mat-stroked-button
        type="button"
        [disabled]="testing() || problems().length > 0"
        (click)="test()"
      >
        @if (testing()) {
          <mat-spinner diameter="16" />
        } @else {
          <mat-icon>play_arrow</mat-icon>
        }
        Test the call
      </button>
      @if (result(); as r) {
        <div class="api-result" [class.failed]="!r.ok">
          <strong>{{
            r.ok ? 'Answered ' + r.status : r.error || 'Answered ' + r.status
          }}</strong>
          <span class="muted"
            >{{ r.request?.method }} {{ r.request?.url }} ·
            {{ r.durationMs }} ms</span
          >
          @if (r.body !== undefined && r.body !== null) {
            <pre>{{ preview(r.body) }}</pre>
          }
        </div>
      }
      @if (problems().length) {
        <ul class="api-problems">
          @for (problem of problems(); track problem) {
            <li><mat-icon>error_outline</mat-icon>{{ problem }}</li>
          }
        </ul>
      }
      @if (data.usedBy.length) {
        <p class="muted">Used by: {{ data.usedBy.join(', ') }}</p>
      }
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      @if (data.remove) {
        <button
          mat-button
          type="button"
          class="danger"
          [disabled]="data.usedBy.length > 0"
          (click)="remove()"
        >
          <mat-icon>delete_outline</mat-icon>Delete
        </button>
      }
      <span class="toolbar-spacer"></span>
      <button mat-button mat-dialog-close>Cancel</button>
      <button
        mat-flat-button
        [disabled]="problems().length > 0"
        (click)="save()"
      >
        <mat-icon>save</mat-icon>Save API
      </button>
    </mat-dialog-actions>
  `,
})
export class ApiEditor {
  readonly data = inject<ApiEditorData>(MAT_DIALOG_DATA)
  private readonly ref = inject(MatDialogRef<ApiEditor>)
  private readonly service = inject(ApiService)
  readonly isNew = !this.data.remove
  readonly api = signal<ApiDef>(structuredClone(this.data.api))
  readonly sample = signal<Record<string, unknown>>({
    ...(this.data.api.sample ?? {}),
  })
  readonly testing = signal(false)
  readonly result = signal<ApiTestResult | null>(null)
  readonly methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
  readonly authTypes = AUTH_TYPES
  readonly places: { value: ParamPlace; label: string }[] = [
    { value: 'path', label: 'Address path {…}' },
    { value: 'query', label: 'Query (?name=)' },
    { value: 'header', label: 'Header' },
    { value: 'body', label: 'Body' },
    { value: 'none', label: 'Not sent (used by authorization)' },
  ]
  readonly problems = computed(() => validateApi(this.api()))
  readonly authInfo = computed(() =>
    AUTH_TYPES.find((type) => type.type === this.api().auth.type),
  )
  readonly headerList = computed(() => Object.entries(this.api().headers))
  readonly argVariables = computed(() => [
    ...this.api().params.map((param) => `args.${param.name}`),
    ...this.data.secretNames.map((name) => `secrets.${name}`),
  ])

  text(value: unknown): string {
    return value === undefined || value === null
      ? ''
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)
  }

  private change(update: (api: ApiDef) => void): void {
    const next = structuredClone(this.api())
    update(next)
    this.api.set(next)
    this.result.set(null)
  }

  set<K extends keyof ApiDef>(
    key: K,
    value: ApiDef[K] | Logic | undefined,
  ): void {
    this.change((api) => {
      if (value === undefined) delete api[key]
      else (api as unknown as Record<string, unknown>)[key] = value
    })
  }

  /** New {placeholders} in the address become path parameters. */
  setUrl(url: string): void {
    this.change((api) => {
      api.url = url.trim()
      for (const name of placeholders(api.url))
        if (!api.params.some((param) => param.name === name))
          api.params.push({ name, in: 'path', required: true })
        else
          api.params = api.params.map((param) =>
            param.name === name
              ? { ...param, in: 'path', required: true }
              : param,
          )
    })
  }

  addParam(): void {
    this.change((api) => {
      let n = api.params.length + 1
      while (api.params.some((param) => param.name === `param${n}`)) n++
      api.params.push({
        name: `param${n}`,
        in: api.method === 'GET' ? 'query' : 'body',
        required: false,
      })
    })
  }
  setParam(index: number, patch: Partial<ApiParam>): void {
    this.change((api) => {
      const param = { ...api.params[index], ...patch }
      if (patch.default === undefined && 'default' in patch)
        delete param.default
      api.params[index] = param
    })
  }
  removeParam(index: number): void {
    this.change((api) => api.params.splice(index, 1))
  }

  addHeader(): void {
    this.change(
      (api) =>
        (api.headers[`X-Header-${Object.keys(api.headers).length + 1}`] = ''),
    )
  }
  setHeader(index: number, name: string, value: string): void {
    this.change((api) => {
      const entries = Object.entries(api.headers)
      entries[index] = [name.trim(), value]
      api.headers = Object.fromEntries(entries)
    })
  }
  removeHeader(index: number): void {
    this.change(
      (api) =>
        (api.headers = Object.fromEntries(
          Object.entries(api.headers).filter((_, i) => i !== index),
        )),
    )
  }

  setAuthType(type: AuthType): void {
    const defaults: Partial<Record<AuthType, Partial<ApiAuth>>> = {
      apiKey: { keyName: 'X-API-Key', keyIn: 'header' },
      hmac: {
        hmacHeader: 'X-Signature',
        hmacAlgorithm: 'SHA-256',
        hmacEncoding: 'hex',
      },
      custom: { headers: {} },
      oauth2: { clientAuth: 'body' },
    }
    this.change((api) => (api.auth = { type, ...(defaults[type] ?? {}) }))
  }
  setAuth(patch: Partial<ApiAuth>): void {
    this.change((api) => {
      api.auth = { ...api.auth, ...patch }
      for (const [key, value] of Object.entries(api.auth))
        if (value === undefined)
          delete (api.auth as unknown as Record<string, unknown>)[key]
    })
  }
  setAuthField(field: keyof ApiAuth, value: unknown): void {
    this.setAuth({ [field]: value } as Partial<ApiAuth>)
  }
  setTokenSource(source: 'secret' | 'step'): void {
    this.change((api) => {
      if (source === 'secret') delete api.auth.token
      else {
        api.auth.token = { var: 'args.token' }
        // The token parameter only feeds the Authorization header; it is not sent on its own.
        if (!api.params.some((param) => param.name === 'token'))
          api.params.push({ name: 'token', in: 'none', required: true })
        else
          api.params = api.params.map((param) =>
            param.name === 'token' ? { ...param, in: 'none' } : param,
          )
      }
    })
  }

  accessChoice(): string[] {
    const rule = this.api().access
    if (!rule || rule.mode === 'public') return ['public']
    if (rule.mode === 'signedIn') return ['signedIn']
    return rule.roles ?? []
  }
  setAccess(choices: string[]): void {
    const last = choices.at(-1)
    const rule: AccessRule | undefined =
      !choices.length || last === 'public'
        ? undefined
        : last === 'signedIn'
          ? { mode: 'signedIn' }
          : {
              mode: 'roles',
              roles: choices.filter(
                (choice) => choice !== 'public' && choice !== 'signedIn',
              ),
            }
    this.set('access', rule)
  }

  setSample(name: string, value: string): void {
    this.sample.update((sample) => {
      const next = { ...sample }
      if (value === '') delete next[name]
      else {
        try {
          next[name] = /^[\[{]|^-?\d+(\.\d+)?$|^(true|false|null)$/.test(
            value.trim(),
          )
            ? JSON.parse(value)
            : value
        } catch {
          next[name] = value
        }
      }
      return next
    })
  }

  preview(body: unknown): string {
    const text = typeof body === 'string' ? body : JSON.stringify(body, null, 2)
    return text.length > 4000
      ? `${text.slice(0, 4000)}\n… (${text.length.toLocaleString()} characters)`
      : text
  }

  async test(): Promise<void> {
    this.testing.set(true)
    this.result.set(null)
    const api = { ...this.api(), sample: this.sample() }
    const project = {
      ...this.data.project,
      apis: [
        ...(this.data.project.apis ?? []).filter((item) => item.id !== api.id),
        api,
      ],
    }
    try {
      this.result.set(
        await this.service.testApi(project, api.id, this.sample()),
      )
    } catch (error) {
      this.result.set({
        ok: false,
        status: 0,
        error: error instanceof Error ? error.message : 'The test failed.',
        durationMs: 0,
      })
    } finally {
      this.testing.set(false)
    }
  }

  save(): void {
    const sample = this.sample()
    const api = {
      ...this.api(),
      ...(Object.keys(sample).length ? { sample } : {}),
    }
    this.data.save(api)
    this.ref.close(api)
  }

  remove(): void {
    if (!confirm(`Delete the API “${this.api().name}”?`)) return
    this.data.remove?.()
    this.ref.close()
  }
}

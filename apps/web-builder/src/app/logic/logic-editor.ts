import { Component, computed, input, output, signal } from '@angular/core'
import { FormsModule } from '@angular/forms'
import { MatButtonModule } from '@angular/material/button'
import { MatIconModule } from '@angular/material/icon'
import { MatMenuModule } from '@angular/material/menu'
import { MatTooltipModule } from '@angular/material/tooltip'
import { MatSlideToggleModule } from '@angular/material/slide-toggle'
import { MatButtonToggleModule } from '@angular/material/button-toggle'
import {
  Logic,
  OPERATOR_CATEGORIES,
  OPERATORS,
  OperatorInfo,
  argsOf,
  describe,
  evaluate,
  isLogic,
  operatorInfo,
  operatorOf,
  validateLogic,
} from '@spsedu360/engine/logic'

type Kind =
  | 'operation'
  | 'variable'
  | 'text'
  | 'number'
  | 'boolean'
  | 'empty'
  | 'list'
  | 'object'

let uid = 0

const defaultFor = (kind: OperatorInfo['args'][number]['kind']): Logic =>
  kind === 'number'
    ? 0
    : kind === 'list'
      ? []
      : kind === 'object'
        ? {}
        : kind === 'logic'
          ? { var: '' }
          : ''

function kindOf(value: Logic): Kind {
  const op = operatorOf(value)
  if (op === 'var') return 'variable'
  if (op) return 'operation'
  if (value === null || value === undefined) return 'empty'
  if (Array.isArray(value)) return 'list'
  if (typeof value === 'object') return 'object'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return 'text'
}

/** One node of a JSON Logic expression, edited visually. Recursive. */
@Component({
  selector: 'logic-node',
  imports: [
    FormsModule,
    MatButtonModule,
    MatIconModule,
    MatMenuModule,
    MatTooltipModule,
    MatSlideToggleModule,
  ],
  templateUrl: './logic-node.html',
})
export class LogicNode {
  readonly value = input<Logic>(null)
  readonly variables = input<string[]>([])
  readonly depth = input(0)
  readonly valueChange = output<Logic>()

  readonly listId = `logic-vars-${++uid}`
  readonly categories = OPERATOR_CATEGORIES
  readonly kind = computed(() => kindOf(this.value()))
  readonly op = computed(() => operatorOf(this.value()) ?? '')
  readonly info = computed(() => operatorInfo(this.op()))
  readonly args = computed(() => argsOf(this.value()))
  readonly entries = computed(() => {
    const value = this.value()
    return value && typeof value === 'object' && !Array.isArray(value)
      ? Object.entries(value)
      : []
  })

  operators(category: string): OperatorInfo[] {
    return OPERATORS.filter(
      (info) => info.category === category && info.op !== 'var',
    )
  }

  argName(index: number): string {
    const info = this.info()
    if (!info) return `Value ${index + 1}`
    const arg = info.args[Math.min(index, info.args.length - 1)]
    return info.variadic && index >= info.args.length - 1 && info.args.length
      ? `${arg?.name ?? 'Value'} ${index + 1}`
      : (arg?.name ?? `Value ${index + 1}`)
  }

  canAddArg(): boolean {
    const info = this.info()
    return !!info && (info.variadic || this.args().length < info.args.length)
  }

  canRemoveArg(index: number): boolean {
    const info = this.info()
    if (!info) return true
    const required = info.variadic
      ? Math.max(1, info.args.length - 1)
      : info.args.length
    return index >= Math.min(required, 1) && this.args().length > 1
  }

  /** Switches the node to another kind, keeping what it can. */
  become(kind: Kind): void {
    const current = this.value()
    const text =
      typeof current === 'string' || typeof current === 'number'
        ? String(current)
        : ''
    const next: Record<Kind, () => Logic> = {
      operation: () => current,
      variable: () => ({ var: '' }),
      text: () => text,
      number: () => Number(text) || 0,
      boolean: () => true,
      empty: () => null,
      list: () => [],
      object: () => ({}),
    }
    this.valueChange.emit(next[kind]())
  }

  /** Uses an operation; the current value becomes its first input. */
  useOperation(info: OperatorInfo): void {
    const current = this.value()
    const args = info.args.map((arg) => defaultFor(arg.kind))
    if (
      info.args.length &&
      current !== null &&
      current !== '' &&
      kindOf(current) !== 'object'
    )
      args[0] = current
    if (
      info.variadic &&
      args.length < 2 &&
      ['+', '*', 'and', 'or', 'cat', 'min', 'max', '??'].includes(info.op)
    )
      args.push(defaultFor(info.args[0].kind))
    if (info.op === 'if' && args.length === 3) args[2] = ''
    this.valueChange.emit({ [info.op]: args })
  }

  setArg(index: number, value: Logic): void {
    const args = [...this.args()]
    args[index] = value
    this.valueChange.emit({ [this.op()]: args })
  }

  addArg(): void {
    const info = this.info()
    const kind =
      info?.args[Math.min(this.args().length, (info?.args.length ?? 1) - 1)]
        ?.kind ?? 'any'
    this.valueChange.emit({ [this.op()]: [...this.args(), defaultFor(kind)] })
  }

  removeArg(index: number): void {
    this.valueChange.emit({
      [this.op()]: this.args().filter((_, i) => i !== index),
    })
  }

  /** Replaces this operation with its first input. */
  unwrap(): void {
    this.valueChange.emit(this.args()[0] ?? null)
  }

  setVariable(name: string): void {
    const args = this.args()
    this.valueChange.emit({ var: args.length > 1 ? [name, args[1]] : name })
  }

  setListItem(index: number, value: Logic): void {
    const list = [...(this.value() as Logic[])]
    list[index] = value
    this.valueChange.emit(list)
  }
  addListItem(): void {
    this.valueChange.emit([...(this.value() as Logic[]), ''])
  }
  removeListItem(index: number): void {
    this.valueChange.emit(
      (this.value() as Logic[]).filter((_, i) => i !== index),
    )
  }

  setEntry(index: number, key: string | null, value?: Logic): void {
    const entries = [...this.entries()]
    const [oldKey, oldValue] = entries[index]
    entries[index] = [key ?? oldKey, value === undefined ? oldValue : value]
    this.valueChange.emit(Object.fromEntries(entries))
  }
  addEntry(): void {
    const entries = this.entries()
    let n = entries.length + 1
    while (entries.some(([key]) => key === `field${n}`)) n++
    this.valueChange.emit({ ...Object.fromEntries(entries), [`field${n}`]: '' })
  }
  removeEntry(index: number): void {
    this.valueChange.emit(
      Object.fromEntries(this.entries().filter((_, i) => i !== index)),
    )
  }

  asString(value: unknown): string {
    return typeof value === 'string'
      ? value
      : value === undefined || value === null
        ? ''
        : String(value)
  }
  variableName(): string {
    const arg = this.args()[0]
    return Array.isArray(arg) ? this.asString(arg[0]) : this.asString(arg)
  }
  number(value: unknown): number {
    return Number(value) || 0
  }
}

/** A labelled logic property: summary, live test result, visual editor and JSON view. */
@Component({
  selector: 'logic-field',
  imports: [
    FormsModule,
    LogicNode,
    MatButtonModule,
    MatIconModule,
    MatTooltipModule,
    MatButtonToggleModule,
  ],
  templateUrl: './logic-field.html',
})
export class LogicField {
  readonly label = input('')
  readonly hint = input('')
  readonly value = input<Logic | undefined>(undefined)
  readonly variables = input<string[]>([])
  /** Data used to show a live result while editing. */
  readonly sample = input<Record<string, unknown> | null>(null)
  /** Start open (e.g. for required fields). */
  readonly startOpen = input(false)
  /** Allow removing the logic entirely (optional properties). */
  readonly optional = input(true)
  readonly valueChange = output<Logic | undefined>()

  readonly open = signal<boolean | null>(null)
  readonly mode = signal<'visual' | 'json'>('visual')
  readonly jsonDraft = signal('')
  readonly jsonError = signal('')

  readonly isOpen = computed(() => this.open() ?? this.startOpen())
  readonly isSet = computed(() => this.value() !== undefined)
  readonly summary = computed(() =>
    this.isSet() ? describe(this.value()) : 'Not set',
  )
  readonly problems = computed(() =>
    this.isSet() ? validateLogic(this.value()) : [],
  )
  readonly result = computed(() => {
    const sample = this.sample()
    if (!this.isSet() || !sample || !isLogic(this.value())) return null
    try {
      const value = evaluate(this.value(), sample)
      const text = JSON.stringify(value)
      return {
        ok: true,
        text:
          text === undefined
            ? 'nothing'
            : text.length > 160
              ? `${text.slice(0, 160)}…`
              : text,
      }
    } catch (error) {
      return {
        ok: false,
        text: error instanceof Error ? error.message : 'Error',
      }
    }
  })

  toggle(): void {
    this.open.set(!this.isOpen())
    if (this.isOpen() && !this.isSet()) this.valueChange.emit('')
  }

  showJson(): void {
    this.mode.set('json')
    this.jsonDraft.set(JSON.stringify(this.value() ?? null, null, 2))
    this.jsonError.set('')
  }

  applyJson(): void {
    try {
      const parsed = JSON.parse(this.jsonDraft())
      const problems = validateLogic(parsed)
      if (problems.length) throw new Error(problems[0])
      this.jsonError.set('')
      this.valueChange.emit(parsed)
    } catch (error) {
      this.jsonError.set(
        error instanceof Error ? error.message : 'Invalid JSON.',
      )
    }
  }

  clear(): void {
    this.valueChange.emit(undefined)
    this.open.set(false)
  }
}

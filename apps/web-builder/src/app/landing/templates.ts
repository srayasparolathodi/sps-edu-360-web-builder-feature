import {
  Block,
  BlockType,
  Project,
  createBlock,
  createProject,
} from '@spsedu360/engine/model'
import {
  Flow,
  FlowStep,
  StepType,
  createFlow,
  createStep,
} from '@spsedu360/engine/flow'

export interface Template {
  id: string
  name: string
  description: string
  icon: string
  create(name: string): Project
}

const block = (
  type: BlockType,
  patch: Partial<Block> = {},
  children: Block[] = [],
): Block => ({
  ...createBlock(type),
  ...patch,
  children,
})

const step = (type: StepType, patch: Partial<FlowStep> = {}): FlowStep => ({
  ...createStep(type),
  ...patch,
})

const flow = (patch: Partial<Flow>, steps: FlowStep[]): Flow => ({
  ...createFlow(patch.name),
  ...patch,
  steps,
})

function schoolSite(name: string): Project {
  const project = createProject(name)
  const contact = flow({ name: 'Send contact form' }, [])
  const check = step('compute', {
    name: 'Check email',
    logic: { isEmail: [{ var: 'event.form.email' }] },
  })
  const thanks = step('notify', {
    name: 'Thank the visitor',
    after: [check.id],
    when: { var: `steps.${check.id}` },
    level: 'success',
    message: {
      cat: ['Thanks ', { var: 'event.form.name' }, '! We will reply soon.'],
    },
  })
  const invalid = step('notify', {
    name: 'Ask for a valid email',
    after: [check.id],
    when: { '!': { var: `steps.${check.id}` } },
    level: 'warning',
    message: 'Please enter a valid email address.',
  })
  contact.steps = [check, thanks, invalid]
  project.flows.push(contact)
  const form = block(
    'form',
    { name: 'Contact form', on: { submit: contact.id } },
    [
      block('input', {
        name: 'Name',
        label: 'Your name',
        text: 'Asha Rao',
        required: true,
        bind: { scope: 'vars', name: 'name' },
      }),
      block('input', {
        name: 'Email',
        label: 'Email',
        text: 'you@example.com',
        inputType: 'email',
        required: true,
        bind: { scope: 'vars', name: 'email' },
      }),
      block('textarea', {
        name: 'Message',
        label: 'Message',
        text: 'How can we help?',
        bind: { scope: 'vars', name: 'message' },
      }),
      block('submit', { text: 'Send message' }),
    ],
  )
  project.pages[0].blocks = [
    block('header', { name: 'Header' }, [
      block('heading', { text: name, level: '3' }),
      block('navigation', {
        label: 'Main menu',
        options:
          'Home|/\nAbout|/about\nAdmissions|/about#admissions\nContact|#contact',
      }),
    ]),
    block('hero', { name: 'Hero' }, [
      block('heading', { text: 'Learning that lasts a lifetime', level: '1' }),
      block('text', {
        text: 'A caring community where every student is known, challenged and supported.',
      }),
      block('button', { text: 'Book a visit', url: '/about' }),
    ]),
    block('grid', { name: 'Highlights', columns: 3 }, [
      block('card', {}, [
        block('icon', { text: 'science' }),
        block('heading', { text: 'STEM labs', level: '3' }),
        block('text', { text: 'Hands-on science and robotics from grade 3.' }),
      ]),
      block('card', {}, [
        block('icon', { text: 'sports_soccer' }),
        block('heading', { text: 'Sports', level: '3' }),
        block('text', { text: 'Football, athletics and swimming every week.' }),
      ]),
      block('card', {}, [
        block('icon', { text: 'palette' }),
        block('heading', { text: 'Arts', level: '3' }),
        block('text', { text: 'Music, theatre and fine arts for all ages.' }),
      ]),
    ]),
    block('section', { name: 'Calendar' }, [
      block('heading', { text: 'Important dates' }),
      block('timeline', {}),
    ]),
    block('quote', {}),
    block('section', { name: 'Contact' }, [
      block('heading', { text: 'Get in touch' }),
      form,
    ]),
    block('accordion', {
      name: 'FAQ',
      options:
        'What are the school hours?|8:30 am to 3:30 pm, Monday to Friday.\nIs there a bus service?|Yes, covering most of the city.',
    }),
    block('footer', { name: 'Footer' }, [
      block('text', {
        text: `© ${new Date().getFullYear()} ${name}. All rights reserved.`,
      }),
    ]),
  ]
  project.pages.push({
    id: crypto.randomUUID(),
    name: 'About',
    path: 'about',
    blocks: [
      block('heading', { text: 'About us', level: '1' }),
      block('richtext', {
        text: '## Our story\nFounded in **1998**, we have grown into a school of 1,200 students.\n\n## Admissions\n- Applications open in June\n- Campus tours every Saturday',
      }),
      block('button', { text: 'Back home', url: '/' }),
    ],
  })
  return project
}

function studentPortal(name: string): Project {
  const project = createProject(name)
  project.variables.push(
    {
      id: crypto.randomUUID(),
      name: 'search',
      scope: 'vars',
      initial: '',
      description: 'Search box text',
    },
    {
      id: crypto.randomUUID(),
      name: 'showHelp',
      scope: 'vars',
      initial: false,
      description: 'Opens the help dialog',
    },
    {
      id: crypto.randomUUID(),
      name: 'visits',
      scope: 'local',
      initial: 0,
      description: 'Visits on this device',
    },
  )
  // Load students: retries, timeout, circuit breaker and a fallback list.
  const fetchStudents = step('http', {
    name: 'Fetch students',
    url: 'https://jsonplaceholder.typicode.com/users',
    timeoutMs: 8000,
    retry: {
      attempts: 3,
      delayMs: 500,
      backoff: 'exponential',
      maxDelayMs: 4000,
    },
    breaker: { enabled: true, failureThreshold: 3, cooldownMs: 30000 },
    onError: {
      action: 'fallback',
      fallback: {
        preserve: [
          {
            id: 1,
            name: 'Sample Student',
            email: 'sample@school.edu',
            company: { name: 'Grade 8' },
          },
        ],
      },
      notify: true,
      message: 'Live data is unavailable, showing saved data. ({error})',
    },
  })
  const shape = step('compute', {
    name: 'Keep the fields we show',
    after: [fetchStudents.id],
    logic: {
      map: [
        { var: `steps.${fetchStudents.id}` },
        {
          object: [
            'id',
            { var: 'id' },
            'name',
            { var: 'name' },
            'email',
            { var: 'email' },
            'grade',
            { var: 'company.name' },
          ],
        },
      ],
    },
    saveAs: { scope: 'vars', name: 'students' },
  })
  const countVisit = step('setVariable', {
    name: 'Count this visit',
    scope: 'local',
    variable: 'visits',
    value: { '+': [{ var: 'local.visits' }, 1] },
  })
  const load = flow(
    {
      name: 'Load students',
      trigger: 'pageLoad',
      result: { var: `steps.${shape.id}` },
    },
    [fetchStudents, shape, countVisit],
  )
  project.flows.push(load)

  const openHelp = flow({ name: 'Open help' }, [
    step('setVariable', {
      name: 'Show help',
      variable: 'showHelp',
      value: true,
    }),
  ])
  project.flows.push(openHelp)

  const fee = flow({ name: 'Fee calculator (server)', runAt: 'server' }, [
    step('compute', {
      name: 'Total fee',
      logic: {
        formatCurrency: [
          { '*': [{ '??': [{ var: 'input.months' }, 12] }, 2500] },
          'INR',
          'en-IN',
        ],
      },
    }),
  ])
  project.flows.push(fee)
  const callFee = flow({ name: 'Show yearly fee' }, [
    step('serverFlow', {
      name: 'Ask the server',
      flowId: fee.id,
      input: { object: ['months', 12] },
      saveAs: { scope: 'vars', name: 'fee' },
    }),
    step('notify', {
      name: 'Show fee',
      level: 'info',
      message: { cat: ['Yearly fee: ', { var: 'vars.fee' }] },
    }),
  ])
  callFee.mode = 'sequential'
  project.flows.push(callFee)

  const detailPage = crypto.randomUUID()
  const fetchOne = step('http', {
    name: 'Fetch student',
    url: {
      cat: [
        'https://jsonplaceholder.typicode.com/users/',
        { var: 'params.studentId' },
      ],
    },
    retry: {
      attempts: 2,
      delayMs: 400,
      backoff: 'exponential',
      maxDelayMs: 2000,
    },
    onError: {
      action: 'stop',
      fallback: null,
      notify: true,
      message: 'Could not load this student. ({error})',
    },
  })
  const loadOne = flow({ name: 'Load student details', trigger: 'manual' }, [
    fetchOne,
  ])
  project.flows.push(loadOne)

  const filtered = {
    filter: [
      { '??': [{ var: 'vars.students' }, []] },
      { contains: [{ var: 'name' }, { var: '../../vars.search' }] },
    ],
  }
  project.pages[0].blocks = [
    block('header', { name: 'Header' }, [
      block('heading', { text: name, level: '3' }),
      block('button', {
        text: 'Help',
        name: 'Help button',
        on: { click: openHelp.id },
      }),
    ]),
    block('grid', { name: 'Stats', columns: 3 }, [
      block('stat', {
        label: 'Students',
        logic: { text: { count: [{ '??': [{ var: 'vars.students' }, []] }] } },
      }),
      block('stat', {
        label: 'Matching search',
        logic: { text: { count: [filtered] } },
      }),
      block('stat', {
        label: 'Your visits on this device',
        logic: { text: { var: 'local.visits' } },
      }),
    ]),
    block('search', {
      name: 'Search',
      label: 'Search students',
      text: 'Type a name…',
      bind: { scope: 'vars', name: 'search' },
    }),
    block(
      'repeater',
      {
        name: 'Student cards',
        columns: 3,
        source: load.id,
        emptyText: 'No students found.',
        logic: { items: filtered },
      },
      [
        block('card', {}, [
          block('avatar', { logic: { text: { var: 'item.name' } } }),
          block('text', { logic: { text: { var: 'item.email' } } }),
          block('chips', { logic: { items: [{ var: 'item.grade' }] } }),
          block('button', {
            text: 'View profile',
            logic: { url: { cat: ['/students/', { var: 'item.id' }] } },
          }),
        ]),
      ],
    ),
    block('chart', {
      label: 'Students by first letter',
      inputType: 'bar',
      source: load.id,
      logic: {
        items: {
          map: [
            {
              entries: [
                {
                  groupBy: [
                    {
                      map: [
                        { var: 'data' },
                        {
                          object: [
                            'letter',
                            { substr: [{ var: 'name' }, 0, 1] },
                          ],
                        },
                      ],
                    },
                    'letter',
                  ],
                },
              ],
            },
            { cat: [{ var: 'key' }, '|', { count: [{ var: 'value' }] }] },
          ],
        },
      },
    }),
    block('button', {
      text: 'Calculate yearly fee (server)',
      on: { click: callFee.id },
    }),
    block(
      'modal',
      { name: 'Help dialog', bind: { scope: 'vars', name: 'showHelp' } },
      [
        block('heading', { text: 'How this portal works', level: '3' }),
        block('richtext', {
          text: 'Students load from an API with **3 retries**, a **circuit breaker** and a **fallback**.\n\nType in the search box to filter. Open a profile to see a page with a **path variable**.',
        }),
      ],
    ),
  ]
  project.pages.push({
    id: detailPage,
    name: 'Student profile',
    path: 'students/:studentId',
    blocks: [
      block('breadcrumb', { options: 'Students|/\nProfile|#' }),
      block('heading', {
        level: '1',
        source: loadOne.id,
        logic: { text: { var: 'data.name' } },
      }),
      block('keyvalue', {
        name: 'Details',
        source: loadOne.id,
        logic: {
          items: {
            map: [
              {
                entries: [
                  {
                    object: [
                      'Email',
                      { var: 'data.email' },
                      'Phone',
                      { var: 'data.phone' },
                      'City',
                      { var: 'data.address.city' },
                      'Student id',
                      { var: 'params.studentId' },
                    ],
                  },
                ],
              },
              { cat: [{ var: 'key' }, '|', { var: 'value' }] },
            ],
          },
        },
      }),
      block('button', { text: 'Back to all students', url: '/' }),
    ],
  })
  return project
}

export const TEMPLATES: Template[] = [
  {
    id: 'blank',
    name: 'Blank',
    description: 'Start from an empty page.',
    icon: 'note_add',
    create: (name) => createProject(name),
  },
  {
    id: 'school',
    name: 'School website',
    description:
      'Header, hero, highlights, dates, FAQ and a contact form with validation.',
    icon: 'school',
    create: schoolSite,
  },
  {
    id: 'portal',
    name: 'Student portal (data app)',
    description:
      'Live API data with retries and fallback, search, repeater, profile pages with path variables, modal, chart and a server flow.',
    icon: 'dashboard',
    create: studentPortal,
  },
]

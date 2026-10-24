import { describe, expect, it } from 'vitest'
import {
  chartPoints,
  embedUrl,
  markdown,
  staticView,
  toItems,
  toRows,
} from './block-view'
import { createBlock } from '@spsedu360/engine/model'

describe('block view helpers', () => {
  it('turns logic results into rows and items', () => {
    expect(toRows(['Email|a@b.co', 'City|Pune'])).toEqual([
      ['Email', 'a@b.co'],
      ['City', 'Pune'],
    ])
    expect(
      toRows([
        { name: 'Asha', grade: 8 },
        { name: 'Ravi', grade: 9 },
      ]),
    ).toEqual([
      ['name', 'grade'],
      ['Asha', '8'],
      ['Ravi', '9'],
    ])
    expect(toItems([{ label: 'Home', url: '/' }, 'Plain'])).toEqual([
      'Home|/',
      'Plain',
    ])
  })

  it('renders a safe markdown subset', () => {
    const html = markdown(
      '## Title\n**bold** <script>x</script>\n- [link](javascript:alert(1))',
    )
    expect(html).toContain('<h3>Title</h3>')
    expect(html).toContain('<strong>bold</strong> &lt;script&gt;')
    expect(html).not.toContain('javascript:')
  })

  it('only embeds allow-listed providers', () => {
    expect(embedUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(
      'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ',
    )
    expect(embedUrl('https://evil.example.com/embed')).toBe('')
    expect(embedUrl('http://vimeo.com/123')).toBe('')
  })

  it('computes chart points from items', () => {
    const view = staticView({ ...createBlock('chart'), options: 'A|2\nB|4' })
    expect(chartPoints(view).map((p) => p.ratio)).toEqual([0.5, 1])
  })
})

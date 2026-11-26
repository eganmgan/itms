export function exportCsv(filename: string, rows: Array<Array<string | number>>) {
  // Recorded remote output is untrusted spreadsheet input. Quoting alone does not
  // prevent formula execution; JSON exports retain the exact original strings.
  const content = rows.map((row) => row.map((cell) => {
    const text = String(cell)
    const safe = typeof cell === 'string' && /^[\s]*[=+@-]/.test(text) ? `'${text}` : text
    return `"${safe.replaceAll('"', '""')}"`
  }).join(',')).join('\n')
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export function exportJson(filename: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' }))
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}

export async function exportElementPdf(element: HTMLElement, filename: string, options: { orientation?: 'portrait' | 'landscape' } = {}) {
  if (!element.isConnected) throw new Error('Report content is no longer available.')
  const html2pdf = (await import('html2pdf.js')).default
  const blob = await html2pdf().set({ margin: 0.3, filename, image: { type: 'jpeg', quality: 0.98 }, html2canvas: { scale: 2.0, useCORS: true }, jsPDF: { unit: 'in', format: 'letter', orientation: options.orientation ?? 'portrait' } }).from(element).outputPdf('blob')
  if (!(blob instanceof Blob) || blob.size === 0) throw new Error('The generated PDF is empty.')
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.style.display = 'none'
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}
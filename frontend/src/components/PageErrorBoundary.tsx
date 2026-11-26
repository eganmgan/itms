import { Component, type ReactNode } from 'react'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import { recordBrowserFailure } from '../lib/browserFailures'

type Props = { token: string; page: string; canOpenSettings: boolean; navigate: (path: string) => void; children: ReactNode }

export class PageErrorBoundary extends Component<Props, { failed: boolean; attempt: number }> {
  state = { failed: false, attempt: 0 }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { recordBrowserFailure(this.props.token, this.props.page) }
  render() {
    if (this.state.failed) return <section role="alert" className="space-y-3 border-l-4 border-rose-500 p-5">
      <h1 className="flex items-center gap-2 text-xl font-bold"><AlertTriangle size={22} />Page failed to load</h1>
      <p>{this.props.page} encountered a rendering error.</p>
      <div className="flex flex-wrap gap-3"><button className="secondary-button inline-flex items-center gap-2" onClick={() => this.setState(state => ({ failed: false, attempt: state.attempt + 1 }))}><RefreshCw size={16} />Retry page</button>{this.props.canOpenSettings && <a href="/settings/watchdog" className="secondary-button" onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); this.props.navigate('/settings/watchdog') } }}>Open watchdog</a>}</div>
    </section>
    return <div key={this.state.attempt}>{this.props.children}</div>
  }
}
import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Moon, ShieldCheck, Sun } from 'lucide-react'
import { login, saveSession, subscribeAuth, verifyMfa } from '../lib/auth'

export interface LoginPageProps {
  isDarkMode?: boolean
  onDarkModeChange?: (isDarkMode: boolean) => void
  onAuthenticated: () => void
}

const inputClasses = 'mt-2 h-11 w-full rounded-md border border-slate-200 bg-white px-3.5 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-blue-600 focus:ring-4 focus:ring-blue-600/10 dark:border-slate-700 dark:bg-slate-950 dark:text-white dark:focus:border-blue-400 dark:focus:ring-blue-400/15'

export function LoginPage({ isDarkMode: controlledDarkMode, onDarkModeChange, onAuthenticated }: LoginPageProps) {
  const [identity, setIdentity] = useState('')
  const [password, setPassword] = useState('')
  const [mfaEmail, setMfaEmail] = useState('')
  const [code, setCode] = useState('')
  const [internalDarkMode, setInternalDarkMode] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [loginError, setLoginError] = useState('')
  const request = useRef<AbortController | null>(null)
  const isDarkMode = controlledDarkMode ?? internalDarkMode

  useEffect(() => {
    const unsubscribe = subscribeAuth(() => {
      request.current?.abort()
      request.current = null
      setIsSubmitting(false)
      setPassword(''); setCode(''); setMfaEmail(''); setLoginError('')
    })
    return () => { request.current?.abort(); unsubscribe() }
  }, [])

  const toggleDarkMode = () => {
    const nextValue = !isDarkMode
    setInternalDarkMode(nextValue)
    onDarkModeChange?.(nextValue)
  }

  const handleLoginSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (request.current) return
    const controller = new AbortController()
    request.current = controller
    setIsSubmitting(true)
    setLoginError('')
    try {
      const result = mfaEmail
        ? await verifyMfa(mfaEmail, code, controller.signal)
        : await login(identity, password, controller.signal)
      if (controller.signal.aborted) return
      setPassword(''); setCode('')
      if (result.kind === 'mfa') {
        setMfaEmail(result.email)
        return
      }
      saveSession(result.token, identity)
      onAuthenticated()
    } catch (error) {
      if (!controller.signal.aborted) {
        setLoginError(error instanceof Error ? error.message : 'Sign in failed. Please try again.')
        setPassword(''); setCode('')
      }
    } finally {
      if (request.current === controller) { request.current = null; setIsSubmitting(false) }
    }
  }

  return <div className={isDarkMode ? 'dark' : ''}>
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-[radial-gradient(circle_at_50%_0%,#dbeafe_0%,#f8fafc_55%,#eef2f7_100%)] p-5 font-sans text-slate-950 transition-colors duration-300 dark:bg-[radial-gradient(circle_at_50%_0%,#172554_0%,#020617_58%,#020617_100%)] dark:text-white sm:p-8">
      <button type="button" className="absolute right-5 top-5 inline-flex h-10 w-10 items-center justify-center rounded-md border border-white/70 bg-white/80 text-slate-600 shadow-sm backdrop-blur transition hover:bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 dark:border-slate-700 dark:bg-slate-900/80 dark:text-slate-300" onClick={toggleDarkMode} aria-label={isDarkMode ? 'Use light mode' : 'Use dark mode'}>
        {isDarkMode ? <Sun size={18} /> : <Moon size={18} />}
      </button>
      <section className="w-full max-w-[390px] rounded-lg border border-white/80 bg-white/90 px-6 py-8 shadow-[0_24px_70px_-28px_rgba(37,99,235,0.3)] backdrop-blur-xl transition-colors duration-300 dark:border-slate-800 dark:bg-slate-900/90 sm:px-8 sm:py-9" aria-labelledby="login-title">
        <header className="mb-7 text-center">
          <span className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-md bg-blue-600 text-white shadow-lg shadow-blue-600/20"><ShieldCheck size={25} /></span>
          <h1 id="login-title" className="text-2xl font-extrabold">Welcome to ITMS</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Sign in to access your operations dashboard</p>
        </header>
        <form onSubmit={handleLoginSubmit} noValidate aria-describedby={loginError ? 'login-error' : undefined}>
          {mfaEmail ? <>
            <p role="status" className="mb-4 text-sm text-slate-500 dark:text-slate-400">MFA required for {mfaEmail}. Enter your authenticator or backup code.</p>
            <label className="block text-xs font-bold uppercase text-slate-500 dark:text-slate-400" htmlFor="mfa-code">MFA code</label>
            <input autoFocus className={inputClasses} id="mfa-code" type="text" autoComplete="one-time-code" value={code} onChange={event => setCode(event.target.value)} disabled={isSubmitting} required />
            <button type="button" className="my-4 text-sm font-bold text-blue-600 dark:text-blue-400" disabled={isSubmitting} onClick={() => { setMfaEmail(''); setCode(''); setPassword(''); setLoginError('') }}>Use a different account</button>
          </> : <>
            <label className="block text-xs font-bold uppercase text-slate-500 dark:text-slate-400" htmlFor="identity">Employee ID or Zerodha email</label>
            <input className={inputClasses} id="identity" type="text" autoComplete="username" placeholder="Z1234 or name@zerodha.com" value={identity} onChange={event => setIdentity(event.target.value)} disabled={isSubmitting} required />
            <label className="mt-5 block text-xs font-bold uppercase text-slate-500 dark:text-slate-400" htmlFor="password">Password</label>
            <input className={inputClasses} id="password" type="password" autoComplete="current-password" placeholder="Enter your password" value={password} onChange={event => setPassword(event.target.value)} disabled={isSubmitting} required />
          </>}
          <p className="my-4 text-xs leading-5 text-slate-500 dark:text-slate-400">You are signed out after 10 minutes of inactivity across ITMS tabs in this browser. The server may expire your session sooner. Sign out on shared devices.</p>
          {loginError && <p id="login-error" role="alert" className="mb-4 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm font-semibold text-rose-700 dark:border-rose-900 dark:bg-rose-950/40 dark:text-rose-300">{loginError}</p>}
          <button type="submit" className="inline-flex h-11 w-full items-center justify-center gap-2 rounded-md bg-blue-600 px-4 text-sm font-bold text-white shadow-lg shadow-blue-600/20 transition hover:bg-blue-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60 dark:focus-visible:ring-offset-slate-900" disabled={isSubmitting}>
            {isSubmitting && <LoaderCircle size={17} className="animate-spin" />}{isSubmitting ? 'Signing in...' : mfaEmail ? 'Verify MFA' : 'Sign in'}
          </button>
        </form>
        <button type="button" className="my-4 text-sm font-bold text-blue-600 hover:underline dark:text-blue-400" onClick={() => setShowHelp(value => !value)} aria-expanded={showHelp} aria-controls="password-help">Forgot password?</button>
        {showHelp && <p id="password-help" className="mb-4 text-sm text-slate-500 dark:text-slate-400">Contact your ITMS administrator to reset your password. Self-service password reset is not available here.</p>}
        <button type="button" disabled aria-describedby="google-unavailable" className="inline-flex h-11 w-full items-center justify-center gap-3 rounded-md border border-slate-200 bg-white px-4 text-sm font-bold text-slate-800 opacity-60 dark:border-slate-700 dark:bg-slate-950 dark:text-white">Sign in with Google</button>
        <p id="google-unavailable" className="mt-2 text-center text-xs text-slate-500 dark:text-slate-400">Google sign-in is unavailable until an integration is configured.</p>
      </section>
    </main>
  </div>
}
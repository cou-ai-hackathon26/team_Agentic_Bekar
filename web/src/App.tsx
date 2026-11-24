import { useCallback, useEffect, useRef, useState } from 'react'
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { Loader2, X } from 'lucide-react'
import { ApiError, api, type CheckResult, type Health, type ItemView, type Stats } from './api'
import { refreshCopy, useCopy } from './copy'
import { Welcome } from './Welcome'
import { CaseScreen } from './CaseScreen'
import { Results } from './Results'
import { Press, TopBar, spring } from './Shell'

type Screen = 'loading' | 'welcome' | 'case' | 'results'

export default function App() {
  const t = useCopy()
  const [screen, setScreen] = useState<Screen>(() => (new URLSearchParams(window.location.search).get('case') ? 'loading' : 'welcome'))
  const [caseId, setCaseId] = useState<string | null>(null)
  const [sample, setSample] = useState(false)
  const [items, setItems] = useState<ItemView[]>([])
  const [result, setResult] = useState<CheckResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stats, setStats] = useState<Stats | null>(null)
  const [health, setHealth] = useState<Health | null>(null)
  const [busy, setBusy] = useState(false)

  const loadHealth = useCallback(() => { api.health().then(setHealth).catch(() => setHealth(null)) }, [])
  useEffect(() => {
    refreshCopy()
    api.stats().then(setStats).catch(() => setError(t('err.server_down')))
    loadHealth()
    const h = window.setInterval(loadHealth, 30_000)
    return () => window.clearInterval(h)
  }, [loadHealth, t])
  const current = useRef<string | null>(null)
  current.current = caseId

  // Opened by link (?case=...): continue that case: confirm screen if anything is unsure, else results.
  useEffect(() => {
    const cid = new URLSearchParams(window.location.search).get('case')
    if (!cid) return
    api.getCase(cid).then(async (c) => {
      setCaseId(c.case_id)
      setItems(c.items)
      const stillReading = Object.values(c.uploads ?? {}).some((u) => u.state === 'reading')
      if (c.items.some((i) => i.needs_confirm) || !c.items.length || stillReading) setScreen('case')
      else { setResult(await api.check(c.case_id)); setScreen('results') }
    }).catch((e) => { setError(e instanceof ApiError && e.status === 404 ? t('err.expired') : t('err.server_down')); setScreen('welcome') })
  }, [t])

  useEffect(() => { window.scrollTo({ top: 0 }) }, [screen])

  function begin(c: { case_id: string; items?: ItemView[] }, isSample: boolean) {
    // the case is in the address: if the phone reloads the page (Android may, after the camera), it comes back
    window.history.replaceState(null, '', `${window.location.pathname}?case=${encodeURIComponent(c.case_id)}`)
    setCaseId(c.case_id)
    setItems(c.items ?? [])
    setSample(isSample)
    setResult(null)
    setScreen('case')
    loadHealth()
  }

  async function start() {
    setError(null); setBusy(true)
    try { begin(await api.newCase(), false) } catch { setError(t('err.server_down')) }
    setBusy(false)
  }

  async function startSample() {
    setError(null); setBusy(true)
    try { begin(await api.sample(), true) } catch { setError(t('err.server_down')) }
    setBusy(false)
  }

  async function check() {
    if (!caseId) return
    setBusy(true)
    try { setResult(await api.check(caseId)); setScreen('results') }
    catch (e) { setError(e instanceof ApiError && e.status === 404 ? t('err.expired') : t('err.generic')) }
    setBusy(false)
  }

  const recheckSeq = useRef(0)
  async function recheck() {
    const id = caseId
    if (!id) return
    const mine = ++recheckSeq.current
    try {
      const [r, c] = await Promise.all([api.check(id), api.getCase(id)])
      if (current.current !== id || mine !== recheckSeq.current) return   // a newer check started meanwhile
      setResult(r); setItems(c.items)
    } catch { if (current.current === id) setError(t('err.generic')) }
  }

  const step = screen === 'case' ? (items.some((i) => i.needs_confirm) ? 1 : 0) : screen === 'results' ? 2 : null
  return (
    <MotionConfig reducedMotion="user">
      <TopBar step={step} health={health} onNew={screen === 'case' || screen === 'results' ? start : null}
        onHome={screen === 'welcome' ? null : () => { setError(null); setScreen('welcome'); if (window.location.search) window.history.replaceState(null, '', window.location.pathname) }} />
      <AnimatePresence>
        {error && (
          <motion.div role="alert" className="fixed inset-x-4 top-20 z-50 mx-auto flex max-w-lg items-start gap-3 rounded-2xl bg-danger p-4 text-white shadow-lg"
            initial={{ opacity: 0, y: -12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -12 }} transition={spring}>
            <p className="flex-1">{error}</p>
            <Press onClick={() => setError(null)} aria-label={t('app.close')} className="-m-2 grid h-11 w-11 place-items-center rounded-full"><X size={20} aria-hidden /></Press>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence mode="popLayout" initial={false}>
        {screen === 'loading' && <div key="l" className="grid min-h-[70dvh] place-items-center"><Loader2 className="animate-spin text-rx" size={28} aria-label={t('working.text')} /></div>}
        {screen === 'welcome' && <Welcome key="w" stats={stats} onStart={start} onSample={startSample} busy={busy} />}
        {screen === 'case' && caseId && (
          <CaseScreen key={`c-${caseId}`} caseId={caseId} items={items} setItems={setItems} onCheck={check} checking={busy}
            stats={stats} health={health} sample={sample} />
        )}
        {screen === 'results' && result && <Results key={`r-${caseId}`} result={result} items={items} onBack={() => setScreen('case')} onRecheck={recheck} />}
      </AnimatePresence>
    </MotionConfig>
  )
}

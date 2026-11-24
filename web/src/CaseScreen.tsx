import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { Camera, FileText, Globe, Images, Keyboard, Loader2, Check, AlertCircle, Mic, Quote, Sparkles, ArrowRight, CircleHelp, Trash2, Search } from 'lucide-react'
import { Recorder } from './Recorder'
import { ApiError, api, bn, bnInt, shrink, statusKey, type Health, type ItemView, type Option, type Stats, type Taking, type WebBrand } from './api'
import { useCopy, t as tt } from './copy'
import { Press, aiReady, spring } from './Shell'

// For several photos at once: which one is being read (n of 'of') and how many medicines each finished one gave.
type Busy = { kind: 'image' | 'voice' | 'text'; preview?: string; n?: number; of?: number; done?: number[] } | null
// One row per photo being read. Photos are read at the same time, and more can be added while they are read.
type Photo = { id: number; preview: string; state: 'reading' | 'done' | 'none' | 'failed' | 'repeat'; found: number; uploadId: string; started: number; lost?: number }
const PHOTO_GIVE_UP_MS = 150_000   // no answer and not in the case after this long: show 'try again'
const PHOTO_LOST_MS = 8_000        // the connection broke and the server never got the photo: 'try again' soon
type Pending = { item: ItemView; index: number; timer: number } | null

function errorText(e: unknown, kind: 'image' | 'voice' | 'text'): string {
  if (e instanceof ApiError) {
    if (e.status === 415) return kind === 'image' ? tt('err.not_photo') : tt('err.generic')
    if (e.status === 502) return tt('err.ai_off')
    if (e.status === 404) return tt('err.expired')
    return tt('err.generic')
  }
  return tt('err.server_down')
}

export function CaseScreen({ caseId, items, setItems, onCheck, checking, stats, health, sample }: {
  caseId: string; items: ItemView[]; setItems: (f: (prev: ItemView[]) => ItemView[]) => void; onCheck: () => void
  checking: boolean; stats: Stats | null; health: Health | null; sample: boolean
}) {
  const t = useCopy()
  const rxInput = useRef<HTMLInputElement>(null)
  const stripInput = useRef<HTMLInputElement>(null)
  const rxCamera = useRef<HTMLInputElement>(null)
  const [rxPick, setRxPick] = useState(false)   // prescription: camera or gallery
  // The phone camera returns one photo per opening; after a camera photo, one tap opens the same camera again.
  const [lastCamera, setLastCamera] = useState<'rx' | 'strip' | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [typing, setTyping] = useState(false)
  const [text, setText] = useState('')
  const [recording, setRecording] = useState(false)
  const [heard, setHeard] = useState<string[]>([])
  const [repeat, setRepeat] = useState<Blob | null>(null)
  const [pending, setPending] = useState<Pending>(null)
  const [doneNote, setDoneNote] = useState<string | null>(null)
  const [photos, setPhotos] = useState<Photo[]>([])
  const photoSeq = useRef(0)
  const reading = photos.some((p) => p.state === 'reading')
  const photosRef = useRef(photos)
  photosRef.current = photos
  const [serverBusy, setServerBusy] = useState(false)   // the server is reading a photo this page did not send (after a reload)
  const gone = useRef(new Set<string>())                // removed by the family: a copy of the case never brings them back
  const [fresh, setFresh] = useState<string[]>([])      // cards just heard by voice: shown under what was heard, outlined
  const ready = aiReady(health)
  const noKey = health ? !health.ai.key_present : false
  // late answers from a case that is no longer on screen must not land in the new one
  const alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  // never the same card twice: an answer can arrive after the case was already re-read from the server
  const addItems = (more: ItemView[]) => { if (alive.current) setItems((prev) => [...prev, ...more.filter((m) => !prev.some((p) => p.item_id === m.item_id))]) }
  const controllers = useRef(new Map<number, AbortController>())
  const blobs = useRef(new Map<number, Blob>())
  const fail = (msg: string) => { if (alive.current) setError(msg) }

  // Remove with undo: the line disappears at once; the server forgets it after 5 s unless the person taps undo.
  // A delete lost on a flaky connection is sent again (and once more before checking): the server must not keep it.
  const deleted = useRef(new Set<string>())
  const sendDelete = useCallback(async (id: string) => {
    for (let k = 0; k < 3; k++) {
      try { await api.remove(caseId, id); deleted.current.add(id); return }
      catch (e) { if (e instanceof ApiError) { deleted.current.add(id); return } await new Promise((r) => setTimeout(r, 700)) }   // 404: already gone
    }
  }, [caseId])
  const flushRemove = useCallback(async (p: Pending) => {
    if (!p) return
    window.clearTimeout(p.timer)
    await sendDelete(p.item.item_id)
  }, [sendDelete])
  function remove(it: ItemView) {
    if (pending) flushRemove(pending)
    const index = items.findIndex((x) => x.item_id === it.item_id)
    gone.current.add(it.item_id)
    setItems((prev) => prev.filter((x) => x.item_id !== it.item_id))
    const timer = window.setTimeout(() => { flushRemove({ item: it, index, timer: 0 }); setPending(null) }, 5000)
    setPending({ item: it, index, timer })
  }
  function undo() {
    if (!pending) return
    window.clearTimeout(pending.timer)
    const p = pending
    gone.current.delete(p.item.item_id)
    setItems((prev) => { const next = [...prev]; next.splice(Math.min(p.index, next.length), 0, p.item); return next })
    setPending(null)
  }
  async function check() {
    const p = pending
    if (p) { setPending(null); await flushRemove(p) }
    await Promise.all([...gone.current].filter((id) => !deleted.current.has(id)).map(sendDelete))
    onCheck()
  }

  const onVoice = useCallback(async (audio: Blob) => {
    setRecording(false)
    setError(null)
    setDoneNote(null)
    setBusy({ kind: 'voice' })
    try {
      const res = await api.addVoice(caseId, audio)
      if (!alive.current) return
      setHeard((h) => [...h, res.transcript])
      addItems(res.items)
      setFresh(res.items.map((i) => i.item_id))
      if (!res.items.length) fail(tt('err.no_items_voice'))
    } catch (e) { fail(errorText(e, 'voice')) }
    if (alive.current) setBusy(null)
  }, [caseId, setItems])

  // Read one photo; several run at the same time (the server only locks the case to save the result).
  async function readPhoto(file: Blob, allowRepeat = false) {
    const id = ++photoSeq.current
    const uploadId = `${caseId}-${Date.now().toString(36)}-${id}`
    const preview = URL.createObjectURL(file)
    setPhotos((ps) => [...ps, { id, preview, state: 'reading', found: 0, uploadId, started: Date.now() }])
    const set = (patch: Partial<Photo>) => { if (alive.current) setPhotos((ps) => ps.map((p) => (p.id === id && p.state === 'reading' ? { ...p, ...patch } : p))) }
    let small: Blob
    try { small = file instanceof File ? await shrink(file) : file } catch { fail(tt('err.not_photo')); set({ state: 'failed' }); return }
    blobs.current.set(id, small)
    const ctrl = new AbortController()
    controllers.current.set(id, ctrl)
    try {
      const res = await api.addImage(caseId, small, allowRepeat, uploadId, ctrl.signal)
      if (!alive.current) return
      if (res.duplicate_of) { setRepeat(small); set({ state: 'repeat' }); return }
      addItems(res.items)
      if (!res.items.length) fail(tt('err.no_items_photo'))
      set({ state: res.items.length ? 'done' : 'none', found: res.items.length })
    } catch (e) {
      if (ctrl.signal.aborted) return                                   // already finished from the case (sync)
      if (e instanceof ApiError) { fail(errorText(e, 'image')); set({ state: 'failed' }); return }   // the server said no
      set({ lost: Date.now() })
      void sync()          // the connection broke (e.g. the camera opened): the server may have read and saved it anyway
    }
  }

  // The server is the record of what was read: ask it which uploads are finished and show their medicines.
  const sync = useCallback(async () => {
    try {
      const c = await api.getCase(caseId)
      if (!alive.current) return
      // Only ADD cards this page does not have. This copy can be older than what happened meanwhile: replacing the
      // list once wiped a whole prescription; updating a card could undo a confirmation; a removed card stays removed.
      setItems((prev) => {
        const known = new Set(prev.map((p) => p.item_id))
        const add = c.items.filter((i) => !known.has(i.item_id) && !gone.current.has(i.item_id))
        return add.length ? [...prev, ...add] : prev
      })
      const ups = c.uploads ?? {}
      const now = Date.now()
      const patches = new Map<number, Partial<Photo>>()
      for (const p of photosRef.current) {
        if (p.state !== 'reading') continue
        const u = ups[p.uploadId]
        if (!u) {      // the server never got it (connection broke while sending), or not yet
          if ((p.lost && now - p.lost > PHOTO_LOST_MS) || now - p.started > PHOTO_GIVE_UP_MS) patches.set(p.id, { state: 'failed' })
          continue
        }
        if (u.state === 'reading') continue
        controllers.current.get(p.id)?.abort()
        if (u.state === 'failed') { patches.set(p.id, { state: 'failed' }); continue }
        if (u.duplicate_of) { const b = blobs.current.get(p.id); if (b) setRepeat(b) }
        patches.set(p.id, { state: u.duplicate_of ? 'repeat' : u.items.length ? 'done' : 'none', found: u.items.length })
      }
      if (patches.size) setPhotos((ps) => ps.map((p) => (p.state === 'reading' && patches.has(p.id) ? { ...p, ...patches.get(p.id) } : p)))
      const mine = new Set(photosRef.current.map((p) => p.uploadId))
      setServerBusy(Object.entries(ups).some(([k, u]) => u.state === 'reading' && !mine.has(k)))
    } catch { /* offline for a moment: the next round asks again */ }
  }, [caseId, setItems])

  // Coming back from the camera, and every few seconds while a photo is being read: ask the case.
  useEffect(() => {
    if (!reading && !serverBusy) return
    const onVisible = () => { if (document.visibilityState === 'visible') void sync() }
    document.addEventListener('visibilitychange', onVisible)
    const h = window.setInterval(() => { void sync() }, serverBusy && !reading ? 2500 : 4000)
    return () => { document.removeEventListener('visibilitychange', onVisible); window.clearInterval(h) }
  }, [reading, serverBusy, sync])
  // Opened again (a reload after the camera, or the link): is the server still reading a photo for this case?
  useEffect(() => { void sync() }, [sync])

  // Just heard: bring what was heard and its cards into view, outlined for a few seconds.
  useEffect(() => {
    if (!fresh.length) return
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    document.getElementById('heard-last')?.scrollIntoView({ behavior: calm ? 'auto' : 'smooth', block: 'start' })
    const h = window.setTimeout(() => setFresh([]), 6000)
    return () => window.clearTimeout(h)
  }, [fresh])

  function retryPhoto(p: Photo) {
    const b = blobs.current.get(p.id)
    setPhotos((ps) => ps.filter((x) => x.id !== p.id))
    URL.revokeObjectURL(p.preview)
    if (b) void readPhoto(b)
  }

  function onFiles(files: FileList | null) {
    if (!files?.length) return
    setError(null)
    setDoneNote(null)
    for (const f of Array.from(files)) void readPhoto(f)
  }

  // When every photo in this round is read: one summary line, and the progress rows go away.
  // A photo that failed stays, with 'try again'.
  useEffect(() => {
    if (reading || !photos.some((p) => p.state !== 'failed')) return
    const finished = photos.filter((p) => p.state !== 'failed')
    const total = finished.reduce((a, p) => a + p.found, 0)
    if (finished.length > 1) setDoneNote(tt('photos.done', { n: bn(finished.length), k: bn(total) }))
    else if (finished[0].found > 1) setDoneNote(tt('photos.one_many', { k: bn(finished[0].found) }))
    finished.forEach((p) => { URL.revokeObjectURL(p.preview); blobs.current.delete(p.id); controllers.current.delete(p.id) })
    setPhotos((ps) => ps.filter((p) => p.state === 'failed'))
  }, [photos, reading])

  function addRepeat() {
    if (!repeat) return
    const blob = repeat
    setRepeat(null)
    void readPhoto(blob, true)
  }

  async function onText() {
    if (!text.trim() || busy) return
    setError(null)
    setDoneNote(null)
    setBusy({ kind: 'text' })
    try {
      const res = await api.addText(caseId, text)
      if (!alive.current) return
      addItems(res.items)
      if (!res.items.length) fail(tt('err.no_items_text'))
      else { setText(''); setTyping(false) }
    } catch (e) { fail(errorText(e, 'text')) }
    if (alive.current) setBusy(null)
  }

  const update = (v: ItemView) => setItems((prev) => prev.map((x) => (x.item_id === v.item_id ? v : x)))
  const unconfirmed = items.filter((i) => i.needs_confirm).length
  const others = (it: ItemView) => items.some((x) => x.item_id !== it.item_id && x.chosen)

  return (
    <motion.main className="mx-auto max-w-2xl px-4 pb-44 pt-6 lg:pt-10" initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -24 }} transition={spring}>
      {sample && <p className="mb-4 rounded-xl bg-rx-soft px-4 py-3 text-[0.95rem] text-rx-deep"><span className="font-bold">{t('sample.badge')}: </span>{t('sample.note')}</p>}
      <h2 className="display text-[1.9rem]">{t('case.title')}</h2>
      <p className="mt-1 text-muted">{t('case.sub')}</p>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Tile icon={<FileText />} label={t('tile.rx')} hint={t('tile.rx_hint')} disabled={!!busy || noKey} active={rxPick} onClick={() => { setRxPick((v) => !v); setTyping(false) }} />
        <Tile icon={<Camera />} label={t('tile.strip')} hint={t('tile.strip_hint')} disabled={!!busy || noKey} onClick={() => stripInput.current?.click()} />
        <Tile icon={<Mic />} label={t('tile.voice')} hint={t('tile.voice_hint')} disabled={!!busy || noKey} onClick={() => setRecording(true)} />
        <Tile icon={<Keyboard />} label={t('tile.type')} hint={t('tile.type_hint')} disabled={!!busy} active={typing} onClick={() => { setTyping((v) => !v); setRxPick(false); setLastCamera(null) }} />
      </div>
      {!ready && <p className="mt-3 flex items-start gap-2 rounded-xl bg-warn-soft p-3 text-[0.95rem] text-warn"><AlertCircle size={18} className="mt-0.5 shrink-0" />{t('err.ai_off')}</p>}
      <input ref={rxInput} type="file" accept="image/*" multiple hidden onChange={(e) => { onFiles(e.target.files); e.target.value = '' }} />
      <input ref={rxCamera} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { onFiles(e.target.files); e.target.value = ''; setLastCamera('rx') }} />
      <input ref={stripInput} type="file" accept="image/*" capture="environment" hidden onChange={(e) => { onFiles(e.target.files); e.target.value = ''; setLastCamera('strip') }} />
      <AnimatePresence>{recording && <Recorder onDone={onVoice} onClose={() => setRecording(false)} />}</AnimatePresence>

      {/* A prescription is photographed on the spot (camera) or picked from saved photos (one or several). */}
      <AnimatePresence initial={false}>
        {rxPick && (
          <motion.div className="mt-3 grid grid-cols-2 gap-3 overflow-hidden" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring}>
            <Tile icon={<Camera />} label={t('tile.rx_camera')} hint={t('tile.rx_camera_hint')} disabled={!!busy} onClick={() => { setRxPick(false); rxCamera.current?.click() }} />
            <Tile icon={<Images />} label={t('tile.rx_gallery')} hint={t('tile.rx_gallery_hint')} disabled={!!busy} onClick={() => { setRxPick(false); setLastCamera(null); rxInput.current?.click() }} />
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence initial={false}>
        {typing && (
          <motion.div className="sheet mt-3 overflow-hidden p-3" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} transition={spring}>
            <label htmlFor="typed" className="text-[0.95rem] text-muted">{t('typed.label')}</label>
            <textarea id="typed" value={text} onChange={(e) => setText(e.target.value)} rows={4} autoFocus placeholder={t('typed.placeholder')}
              className="print mt-1 w-full resize-none rounded-xl bg-paper p-3 text-[1.05rem] outline-none focus:ring-2 focus:ring-rx/40" />
            <Press onClick={onText} disabled={!text.trim() || !!busy} className="mt-2 min-h-12 w-full rounded-xl bg-rx font-semibold text-white disabled:opacity-40">{t('typed.add')}</Press>
          </motion.div>
        )}
      </AnimatePresence>

      <div aria-live="polite" aria-atomic="false">
        {error && <p role="alert" className="mt-4 flex items-start gap-2 rounded-xl bg-danger-soft p-3 text-[1rem] text-danger"><AlertCircle className="mt-1 shrink-0" size={18} />{error}</p>}
        <AnimatePresence>{busy && <Working busy={busy} products={stats?.products} />}</AnimatePresence>
        {lastCamera && (
          <Press onClick={() => (lastCamera === 'rx' ? rxCamera : stripInput).current?.click()} disabled={noKey}
            className="mt-4 flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-rx text-[1.1rem] font-semibold text-white disabled:opacity-40">
            <Camera size={22} aria-hidden />{t(lastCamera === 'rx' ? 'photos.another_rx' : 'photos.another_strip')}
          </Press>
        )}
        <AnimatePresence>
          {photos.length === 1 && reading && <Working busy={{ kind: 'image', preview: photos[0].preview }} products={stats?.products} />}
          {(photos.length > 1 || photos.some((p) => p.state === 'failed')) && <PhotoProgress photos={photos} onRetry={retryPhoto} />}
        </AnimatePresence>
        {serverBusy && !reading && <p role="status" className="mt-4 flex items-center gap-2 rounded-xl bg-rx-soft p-3 text-[1rem] text-rx-deep"><Loader2 size={18} className="shrink-0 animate-spin" aria-hidden />{t('photos.server_reading')}</p>}
        {doneNote && !busy && <p role="status" className="mt-4 flex items-start gap-2 rounded-xl bg-rx-soft p-3 text-[1rem] text-rx-deep"><Check className="mt-1 shrink-0" size={18} strokeWidth={3} aria-hidden />{doneNote}</p>}
        <AnimatePresence>
          {repeat && (
            <motion.div className="sheet mt-4 p-4" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}>
              <p className="font-semibold">{t('dupdoc.title')}</p>
              <p className="mt-1 text-[0.95rem] text-muted">{t('dupdoc.hint')}</p>
              <Press onClick={addRepeat} className="mt-3 min-h-11 rounded-xl bg-paper px-4 text-[0.95rem] font-semibold ring-1 ring-foil">{t('dupdoc.add_anyway')}</Press>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {heard.map((h, k) => (
        <p key={k} id={k === heard.length - 1 ? 'heard-last' : undefined} className="mt-4 flex scroll-mt-24 gap-2 rounded-2xl bg-white p-3 text-[1rem] ring-1 ring-foil">
          <Quote size={16} className="mt-1 shrink-0 text-pen" /><span><span className="text-muted">{t('heard')}: </span><span className="text-pen">{h}</span>
            {k === heard.length - 1 && items.some((i) => i.source === 'voice' && i.needs_confirm) && <span className="mt-1 block font-semibold text-ink">{t('heard.confirm')}</span>}</span>
        </p>
      ))}

      {!items.length && !busy && !reading ? <Empty /> : (
        <ul className="mt-6 space-y-4">
          <AnimatePresence initial={false}>
            {[...items.filter((i) => i.source === 'voice'), ...items.filter((i) => i.source !== 'voice')].map((it) => (   // spoken ones right under what was heard
              <motion.li key={it.item_id} layout initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, height: 0, marginTop: 0, transition: { duration: 0.12 } }} transition={spring}>
                <MedicineCard caseId={caseId} it={it} onUpdate={update} onRemove={() => remove(it)} canResolve={others(it)} highlight={fresh.includes(it.item_id)} />
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      <AnimatePresence>
        {pending && (
          <motion.div role="status" className="fixed inset-x-4 bottom-32 z-30 mx-auto flex max-w-md items-center justify-between gap-3 rounded-2xl bg-ink px-4 py-3 text-white shadow-lg"
            initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} transition={spring}>
            <span className="min-w-0 truncate">{t('item.removed', { brand: pending.item.chosen?.brand ?? pending.item.reading })}</span>
            <Press onClick={undo} className="min-h-11 shrink-0 rounded-xl px-3 font-semibold text-[#9fd3c2]">{t('item.undo')}</Press>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="glass-strong fixed inset-x-0 bottom-0 z-20 border-t border-foil px-4 pb-[max(16px,env(safe-area-inset-bottom))] pt-3">
        <div className="mx-auto max-w-2xl">
          <p className={`mb-2 h-6 whitespace-nowrap text-center text-[0.95rem] font-semibold text-warn ${unconfirmed ? '' : 'invisible'}`}>{t('check.pending', { n: bn(unconfirmed) })}</p>
          <Press onClick={check} disabled={!items.length || !!busy || reading || serverBusy || checking}
            className="flex min-h-14 w-full items-center justify-center gap-2 rounded-2xl bg-ink text-[1.15rem] font-semibold text-white disabled:opacity-40">
            {checking && <Loader2 size={20} className="animate-spin" />}
            {t('check.button')}{items.length ? ` (${t('check.count', { n: bn(items.length) })})` : ''}
          </Press>
        </div>
      </div>
    </motion.main>
  )
}

function Empty() {
  const t = useCopy()
  return (
    <div className="mt-6 grid place-items-center rounded-[20px] border-2 border-dashed border-foil px-6 py-12 text-center">
      <FileText className="text-muted/40" size={44} />
      <p className="mt-3 text-[1.05rem] font-semibold">{t('empty.title')}</p>
      <p className="mt-1 max-w-sm text-muted">{t('empty.hint')}</p>
    </div>
  )
}

// While a photo is read: the photo itself, with a scan line passing over it (static under reduced motion).
function Working({ busy, products }: { busy: NonNullable<Busy>; products?: number }) {
  const t = useCopy()
  const reduce = useReducedMotion()
  const several = busy.kind === 'image' && (busy.of ?? 1) > 1
  const title = several ? t('working.image_n', { i: bn(busy.n ?? 1), n: bn(busy.of ?? 1) })
    : busy.kind === 'image' ? t('working.image') : busy.kind === 'voice' ? t('working.voice') : t('working.text')
  const hint = busy.kind === 'image' ? t('working.image_hint', { n: products ? bnInt(products) : '' }) : busy.kind === 'voice' ? t('working.voice_hint') : ''
  return (
    <motion.div className="sheet lift mt-4 overflow-hidden p-4" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}>
      {several && busy.done?.map((k, j) => (
        <p key={j} className="mb-2 flex items-center gap-1.5 whitespace-nowrap text-[0.95rem] font-semibold text-rx-deep"><Check size={16} strokeWidth={3} aria-hidden />{t('working.image_done', { i: bn(j + 1), k: bn(k) })}</p>
      ))}
      <div className="flex items-center gap-4">
      {busy.preview ? (
        <div className="relative h-24 w-32 shrink-0 overflow-hidden rounded-xl bg-paper">
          <img src={busy.preview} alt="" className="h-full w-full object-cover" />
          {!reduce && <motion.div aria-hidden className="absolute inset-x-0 h-10 bg-gradient-to-b from-transparent via-rx/35 to-transparent"
            initial={{ y: '-40%' }} animate={{ y: '260%' }} transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut', repeatType: 'reverse' }} />}
        </div>
      ) : <div className="grid h-14 w-14 shrink-0 place-items-center rounded-full bg-rx-soft text-rx"><Loader2 className="animate-spin" aria-hidden /></div>}
      <div><p className="text-[1.05rem] font-semibold">{title}</p>{hint && <p className="text-[0.95rem] text-muted">{hint}</p>}</div>
      </div>
    </motion.div>
  )
}

// Several photos: one row each, with what that photo gave once it is read.
function PhotoProgress({ photos, onRetry }: { photos: Photo[]; onRetry: (p: Photo) => void }) {
  const t = useCopy()
  const reduce = useReducedMotion()
  const label = (p: Photo, i: number) => {
    const n = bn(i + 1)
    return p.state === 'reading' ? t('photos.row_reading', { i: n }) : p.state === 'done' ? t('working.image_done', { i: n, k: bn(p.found) })
      : p.state === 'none' ? t('photos.row_none', { i: n }) : p.state === 'repeat' ? t('photos.row_repeat', { i: n }) : t('photos.row_failed', { i: n })
  }
  return (
    <motion.div className="sheet lift mt-4 p-4" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={spring}>
      <p className="text-[1.05rem] font-semibold">{t('photos.title')}</p>
      <ul className="mt-3 space-y-2">
        {photos.map((p, i) => (
          <li key={p.id} className="flex items-center gap-3">
            <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-lg bg-paper">
              <img src={p.preview} alt="" className="h-full w-full object-cover" />
              {p.state === 'reading' && !reduce && <motion.div aria-hidden className="absolute inset-x-0 h-6 bg-gradient-to-b from-transparent via-rx/35 to-transparent"
                initial={{ y: '-40%' }} animate={{ y: '220%' }} transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut', repeatType: 'reverse' }} />}
            </div>
            <p className={`flex items-center gap-1.5 text-[0.95rem] ${p.state === 'done' ? 'font-semibold text-rx-deep' : p.state === 'reading' ? 'text-ink' : 'text-warn'}`}>
              {p.state === 'reading' ? <Loader2 size={16} className="animate-spin" aria-hidden /> : p.state === 'done' ? <Check size={16} strokeWidth={3} aria-hidden /> : <AlertCircle size={16} aria-hidden />}
              {label(p, i)}
            </p>
            {p.state === 'failed' && <Press onClick={() => onRetry(p)} className="ml-auto min-h-11 shrink-0 rounded-full bg-paper px-3 text-[0.9rem] font-semibold text-rx ring-1 ring-foil">{t('photos.retry')}</Press>}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-[0.9rem] text-muted">{t('photos.more')}</p>
    </motion.div>
  )
}

function Tile({ icon, label, hint, onClick, active, disabled }: { icon: React.ReactNode; label: string; hint: string; onClick: () => void; active?: boolean; disabled?: boolean }) {
  return (
    <Press onClick={onClick} disabled={disabled} aria-pressed={active}
      className={`flex min-h-24 flex-col items-center justify-center gap-1.5 rounded-2xl bg-white px-2 py-3 text-center ring-1 disabled:opacity-40 ${active ? 'ring-2 ring-rx' : 'ring-foil'}`}>
      <span className="grid h-11 w-11 place-items-center rounded-full bg-rx-soft text-rx">{icon}</span>
      <span className="leading-tight"><span className="label block whitespace-nowrap text-[1rem] font-semibold">{label}</span><span className="text-[0.85rem] text-muted">{hint}</span></span>
    </Press>
  )
}

function StatusChips({ value, onChange, busy, applied }: { value: Taking; onChange: (v: Taking) => void; busy: boolean; applied?: boolean }) {
  const t = useCopy()
  const opts: Taking[] = ['current', 'stopped', 'unsure']
  const id = useId()
  return (
    <div className="mt-3">
      <p id={id} className="mb-1.5 text-[0.95rem] text-muted">{t(applied ? 'status.label_applied' : 'status.label')}</p>
      <div role="radiogroup" aria-labelledby={id} className="flex flex-wrap gap-2">
        {opts.map((o) => (
          <Press key={o} role="radio" aria-checked={value === o} disabled={busy} onClick={() => onChange(o)}
            className={`flex min-h-11 items-center gap-1.5 rounded-full px-4 text-[0.95rem] font-semibold ring-1 ${value !== o ? 'bg-white text-ink ring-foil'
              : o === 'current' ? 'bg-rx text-white ring-rx' : o === 'stopped' ? 'bg-ink text-white ring-ink' : 'bg-paper text-ink ring-2 ring-muted/50'}`}>
            {value === o && <Check size={16} strokeWidth={3} aria-hidden />}{t(statusKey(o, applied))}
          </Press>
        ))}
      </div>
    </div>
  )
}

function MedicineCard({ caseId, it, onUpdate, onRemove, canResolve, highlight = false }: { caseId: string; it: ItemView; onUpdate: (v: ItemView) => void; onRemove: () => void; canResolve: boolean; highlight?: boolean }) {
  const t = useCopy()
  const [cropOk, setCropOk] = useState(true)
  const [changing, setChanging] = useState(false)
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  useEffect(() => setCropOk(true), [it.item_id])
  const s = it.schedule
  const slots = s && [s.morning, s.noon, s.night].some((v) => v !== null) ? `${bn(s.morning ?? 0)}+${bn(s.noon ?? 0)}+${bn(s.night ?? 0)}` : null
  const chips = [slots ? t('sched.slots', { slots }) : s?.per_day ? t('sched.per_day', { n: bn(s.per_day) }) : null,
    s?.meal ? t(s.meal === 'after' ? 'sched.after' : 'sched.before') : null, s?.days ? t('sched.days', { n: bn(s.days) }) : null].filter(Boolean) as string[]
  const ink = it.handwritten || it.source === 'voice'
  const said = it.source === 'voice' ? t('item.read_voice') : it.source === 'text' ? t('item.read_text') : t('item.read_photo')
  const where = it.source === 'rx' ? (it.doctor && !/^D\d+$/.test(it.doctor) ? t('item.from_doctor', { doctor: it.doctor }) : t('item.from_rx')) : t('item.from_bag')

  async function run(fn: () => Promise<ItemView>) {
    setSaving(true); setErr(null)
    try { onUpdate(await fn()); setChanging(false) } catch { setErr(tt('err.generic')) }
    setSaving(false)
  }

  return (
    <article className={`sheet p-4 transition-[outline-color] duration-700 ${highlight ? 'outline-3 outline-offset-2 outline-pen' : 'outline-0 outline-transparent'}`} aria-label={it.chosen?.brand ?? it.reading}>
      {/* the source (which prescription, or the bag) gets its own full-width line: a long doctor's name is never cut off */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex shrink-0 items-center gap-1">
          {it.needs_confirm ? <span className="flex items-center gap-1 whitespace-nowrap rounded-full bg-warn-soft px-2.5 py-1 text-[0.85rem] font-semibold text-warn"><CircleHelp size={14} aria-hidden />{t('steps.confirm')}</span>
            : it.chosen ? <span className="flex items-center gap-1 whitespace-nowrap rounded-full bg-rx-soft px-2.5 py-1 text-[0.85rem] font-semibold text-rx"><Check size={14} strokeWidth={3} aria-hidden />{t('item.matched')}</span>
            : <span className="flex items-center gap-1 whitespace-nowrap rounded-full bg-danger-soft px-2.5 py-1 text-[0.85rem] font-semibold text-danger"><CircleHelp size={14} aria-hidden />{t('item.not_found')}</span>}
        </div>
        <Press onClick={onRemove} aria-label={`${t('item.remove')}: ${it.chosen?.brand ?? it.reading}`} className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted"><Trash2 size={18} /></Press>
      </div>
      <p className="mt-1 break-words text-[0.9rem] text-muted">{where}</p>
      {it.has_crop && cropOk && (
        <div className="mt-3 flex h-16 items-center overflow-hidden rounded-lg bg-white ring-1 ring-foil">
          <img src={api.cropUrl(caseId, it.item_id)} onError={() => setCropOk(false)} alt={`${said}: ${it.reading}`} className="block h-full w-auto max-w-full object-contain object-left" />
        </div>
      )}
      <p className="mt-3 text-[0.9rem] text-muted">{said}{it.handwritten ? ` (${t('item.handwritten')})` : ''}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`${ink ? 'hand text-[1.35rem]' : 'print text-[1.1rem] text-muted'} leading-tight`}>{it.reading || '—'}</span>
        {it.chosen && <>
          <ArrowRight size={18} className="shrink-0 text-muted" aria-hidden />
          <span className="print text-[1.25rem] font-semibold leading-tight">{it.chosen.brand} <span className="font-normal text-muted">{it.chosen.strength}</span></span>
        </>}
      </div>
      {it.chosen && <p className="mt-0.5 text-[0.9rem] text-muted">{it.chosen.form}{it.chosen.maker ? `, ${it.chosen.maker}` : ''}</p>}
      {it.chosen?.web && <p className="mt-0.5 text-[0.9rem] text-muted">{t('web.source')}: <a href={it.chosen.web} target="_blank" rel="noreferrer" className="font-semibold text-rx underline">MedEx</a></p>}
      {chips.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{chips.map((c) => <span key={c} className="whitespace-nowrap rounded-full bg-paper px-3 py-1 text-[0.9rem] text-ink ring-1 ring-foil">{c}</span>)}</div>}

      {(it.needs_confirm || !it.chosen || changing) ? (
        <Abstain caseId={caseId} it={it} saving={saving} canResolve={canResolve} onCancel={changing ? () => setChanging(false) : undefined}
          onChoose={(pid) => run(() => api.confirm(caseId, it.item_id, pid, it.per_day))}
          onWeb={(url) => run(() => api.addWeb(caseId, it.item_id, url))}
          onResolve={() => run(() => api.resolve(caseId, it.item_id))} />
      ) : <>
        <StatusChips value={it.taking} busy={saving} applied={!!it.chosen?.applied} onChange={(v) => run(() => api.status(caseId, it.item_id, v))} />
        <Press onClick={() => setChanging(true)} className="mt-2 min-h-11 text-[0.95rem] font-semibold text-rx underline-offset-4 hover:underline">{t('item.change')}</Press>
      </>}
      {err && <p role="alert" className="mt-2 text-[0.95rem] text-danger">{err}</p>}
    </article>
  )
}

// When the matcher is not sure (or the person says "not right"): the photo line, the closest registered products,
// a search over the whole registry, and an optional evidence search over the rest of the case.
function Abstain({ caseId, it, saving, canResolve, onChoose, onWeb, onResolve, onCancel }: {
  caseId: string; it: ItemView; saving: boolean; canResolve: boolean
  onChoose: (pid: number | null) => void; onWeb: (url: string) => void; onResolve: () => void; onCancel?: () => void
}) {
  const t = useCopy()
  const [searching, setSearching] = useState(false)
  const [q, setQ] = useState('')
  const [results, setResults] = useState<Option[] | null>(null)
  const [looking, setLooking] = useState(false)
  const [web, setWeb] = useState<{ state: 'idle' | 'busy' | 'done'; results: WebBrand[] }>({ state: 'idle', results: [] })
  void caseId
  useEffect(() => { setWeb({ state: 'idle', results: [] }) }, [q])
  useEffect(() => {
    if (!searching || q.trim().length < 2) { setResults(null); return }
    const h = window.setTimeout(() => { api.search(q).then((r) => setResults(r.options)).catch(() => setResults([])) }, 250)
    return () => window.clearTimeout(h)
  }, [q, searching])
  const suggested = it.agent?.product_id
  const option = (o: Option) => (
    <Press key={o.product_id} disabled={saving} onClick={() => onChoose(o.product_id)}
      className={`print flex min-h-12 w-full items-center justify-between gap-3 rounded-xl px-4 text-left ring-1 ${suggested === o.product_id ? 'bg-rx-soft ring-2 ring-rx' : 'bg-white ring-foil'}`}>
      <span className="min-w-0"><span className="text-[1.1rem] font-semibold">{o.brand}</span> <span className="text-muted">{o.strength}</span>
        <span className="block break-words text-[0.85rem] text-muted">{o.form}{o.maker ? `, ${o.maker}` : ''}</span></span>
      {suggested === o.product_id && <span className="shrink-0 rounded-full bg-rx px-2 py-0.5 text-[0.8rem] font-semibold text-white">{t('abstain.suggested')}</span>}
    </Press>
  )
  return (
    <div className="mt-4 rounded-2xl bg-warn-soft/70 p-3">
      {it.needs_confirm && <p className="flex items-center gap-2 text-[1.05rem] font-bold text-warn"><CircleHelp size={18} aria-hidden />{t('abstain.title')}</p>}
      <p className="mb-3 mt-1 text-[0.95rem] text-ink">{it.has_crop ? t('abstain.photo') : t('abstain.other')}</p>
      {it.agent?.reason_bn && (
        <p className="mb-3 flex gap-2 rounded-xl bg-white p-3 text-[1rem]"><Sparkles size={16} className="mt-1 shrink-0 text-rx" aria-hidden />
          <span><span className="font-semibold">{t('abstain.suggested')}: </span>{it.agent.reason_bn}</span></p>
      )}
      {it.agent && !it.agent.product_id && <p className="mb-3 text-[0.95rem] text-muted">{t('abstain.no_clue')}</p>}
      {/* once the person types, only what they typed is shown: the earlier guesses would sit above the right answer */}
      {!(searching && q.trim().length >= 2) && <div className="space-y-2">{it.options.map(option)}</div>}
      {!searching ? (
        <div className="mt-3 flex flex-wrap gap-x-4">
          <Press onClick={() => setSearching(true)} className="flex min-h-11 items-center gap-1.5 text-[0.95rem] font-semibold text-rx"><Search size={16} aria-hidden />{t('abstain.none')}</Press>
          {canResolve && !it.agent && (
            <Press disabled={looking} onClick={async () => { setLooking(true); try { await onResolve() } finally { setLooking(false) } }}
              className="flex min-h-11 items-center gap-1.5 text-[0.95rem] font-semibold text-rx disabled:opacity-60" title={t('abstain.clues_hint')}>
              {looking ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Sparkles size={16} aria-hidden />}{t('abstain.clues')}
            </Press>
          )}
          {onCancel && <Press onClick={onCancel} className="min-h-11 text-[0.95rem] text-muted">{t('app.close')}</Press>}
        </div>
      ) : (
        <div className="mt-3">
          <label htmlFor={`s-${it.item_id}`} className="text-[0.95rem] text-muted">{t('abstain.search_label')}</label>
          <input id={`s-${it.item_id}`} autoFocus value={q} onChange={(e) => setQ(e.target.value)}
            className="print mt-1 min-h-12 w-full rounded-xl bg-white px-3 text-[1.05rem] ring-1 ring-foil outline-none focus:ring-2 focus:ring-rx/50" />
          <div className="mt-2 space-y-2">
            {results?.map(option)}
            {results && !results.length && <p className="text-[0.95rem] text-muted">{t('abstain.no_results')}</p>}
          </div>
          {/* not an exact name in our registry: look it up on MedEx (only the name is sent); a result is used only when tapped */}
          {results && !results.some((o) => o.brand.toLowerCase() === q.trim().toLowerCase().split(/\s+/)[0]) && (
            <div className="mt-3">
              {web.state !== 'done' && (
                <Press disabled={web.state === 'busy'} onClick={async () => {
                  setWeb({ state: 'busy', results: [] })
                  try { const r = await api.web(q.trim()); setWeb({ state: 'done', results: r.results }) } catch { setWeb({ state: 'done', results: [] }) }
                }} className="flex min-h-11 items-center gap-1.5 text-[0.95rem] font-semibold text-rx disabled:opacity-60">
                  {web.state === 'busy' ? <Loader2 size={16} className="animate-spin" aria-hidden /> : <Globe size={16} aria-hidden />}{t('web.search')}
                </Press>
              )}
              {web.state === 'done' && !web.results.length && <p className="text-[0.95rem] text-muted">{t('web.none')}</p>}
              <div className="space-y-2">
                {web.results.map((b) => (
                  <div key={b.url} className="rounded-xl bg-white p-3 ring-1 ring-foil">
                    <Press disabled={saving} onClick={() => onWeb(b.url)} className="print w-full text-left">
                      <span className="text-[1.1rem] font-semibold">{b.brand}</span> <span className="text-muted">{b.strength}</span>
                      <span className="block break-words text-[0.85rem] text-muted">{b.form}{b.maker ? `, ${b.maker}` : ''}</span>
                      <span className="block break-words text-[0.9rem] text-ink">{t('web.inside')}: {b.generic}</span>
                    </Press>
                    <a href={b.url} target="_blank" rel="noreferrer" className="mt-1 inline-block text-[0.85rem] font-semibold text-rx underline">{t('web.source')}: MedEx</a>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

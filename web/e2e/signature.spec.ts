import { expect, test, type Page } from '@playwright/test'

// The judge's path, end to end, on the real server: sample case -> ask "taken now?" -> red reveal -> card -> details;
// plus the not-sure path (registry search) and remove/undo. No horizontal scrolling at any step, on laptop and phone.
const shots = (name: string) => `e2e/screens/${test.info().project.name}-${name}.png`

async function noSideScroll(page: Page) {
  const extra = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(extra, 'page scrolls sideways').toBe(0)
}

test('sample case: asks first, warns only when both are taken now', async ({ page }) => {
  await page.route('**/speech', (r) => r.fulfill({ status: 200, contentType: 'audio/wav', body: Buffer.alloc(64) }))
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await noSideScroll(page)
  await page.screenshot({ path: shots('1-welcome'), fullPage: true })

  await page.getByRole('button', { name: 'নমুনা দেখুন' }).click()
  await expect(page.getByRole('article')).toHaveCount(3)
  await noSideScroll(page)
  await page.screenshot({ path: shots('2-case'), fullPage: true })

  await page.getByRole('button', { name: /মিলিয়ে দেখুন/ }).click()
  await expect(page.getByText('দুটোই কি এখন খাচ্ছেন?').first()).toBeVisible()
  await expect(page.getByText('গুরুত্বপূর্ণ সতর্কতা')).toHaveCount(0)
  await page.screenshot({ path: shots('3-ask'), fullPage: true })

  for (const brand of ['Napa', 'Ace']) {
    await page.locator(`[role="radiogroup"][aria-label^="${brand}"]`).getByRole('radio', { name: 'এখন খাচ্ছেন' }).click()
    await page.waitForTimeout(600)
  }
  await expect(page.getByText('গুরুত্বপূর্ণ সতর্কতা')).toBeVisible()
  await expect(page.getByText('Paracetamol').first()).toBeVisible()
  await noSideScroll(page)
  await page.screenshot({ path: shots('4-reveal'), fullPage: true })

  await page.getByRole('button', { name: 'ফার্মাসিস্টকে দেখানোর কার্ড' }).click()
  const dialog = page.getByRole('dialog')
  await expect(dialog.getByRole('img')).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'ফিরে যান' })).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)

  await page.getByRole('button', { name: 'কীভাবে জানলাম' }).click()
  await expect(page.getByText('নাম মেলানোর পরীক্ষা')).toBeVisible()
  await noSideScroll(page)
  await page.screenshot({ path: shots('5-details'), fullPage: true })
})

test('not sure: search the registry, remove and undo', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'ওষুধের ব্যাগ পরীক্ষা করুন' }).click()
  await page.getByRole('button', { name: /লিখে দিন/ }).click()
  await page.locator('textarea').fill('Seclo 20\nNap 500')
  await page.getByRole('button', { name: 'তালিকায় যোগ করুন' }).click()
  await expect(page.getByText('নামটি নিশ্চিত নয়')).toBeVisible()
  await page.getByRole('button', { name: 'কোনোটিই নয়, নাম লিখুন' }).click()
  await page.getByLabel('ওষুধের নাম লিখে খুঁজুন').fill('napa extra')
  await page.getByRole('button', { name: /Napa Extra/ }).first().click()
  await expect(page.getByText('নামটি নিশ্চিত নয়')).toHaveCount(0)
  await expect(page.getByRole('article').filter({ hasText: 'Napa Extra' })).toBeVisible()
  await noSideScroll(page)
  await page.screenshot({ path: shots('6-chosen'), fullPage: true })

  await page.getByRole('button', { name: /বাদ দিন: Seclo/ }).click()
  await expect(page.getByRole('article')).toHaveCount(1)
  await page.getByRole('button', { name: 'ফিরিয়ে আনুন' }).click()
  await expect(page.getByRole('article')).toHaveCount(2)
})

test('an unchecked line is never shown as an all-clear', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'ওষুধের ব্যাগ পরীক্ষা করুন' }).click()
  await page.getByRole('button', { name: /লিখে দিন/ }).click()
  await page.locator('textarea').fill('Seclo 20\nNap 500')
  await page.getByRole('button', { name: 'তালিকায় যোগ করুন' }).click()
  await expect(page.getByText('নামটি নিশ্চিত নয়')).toBeVisible()
  await page.getByRole('button', { name: /মিলিয়ে দেখুন/ }).click()
  await expect(page.getByRole('heading', { name: '১টি ওষুধ যাচাই বাকি' })).toBeVisible()
  await expect(page.getByText('দুবার পাওয়া যায়নি')).toHaveCount(0)
  await expect(page.getByText('নাম নিশ্চিত হয়নি, তাই যাচাইয়ে ধরা হয়নি')).toBeVisible()
  await expect(page.getByRole('heading', { name: 'ওষুধগুলো যোগ করুন' })).toHaveCount(0)   // the screen change has settled
  await noSideScroll(page)
  await page.screenshot({ path: shots('6-partial'), fullPage: true })
  await page.getByRole('button', { name: 'নামগুলো নিশ্চিত করুন' }).click()
  await expect(page.getByText('নামটি নিশ্চিত নয়')).toBeVisible()
})

test('every verdict heading fits on one line', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const lines = await page.evaluate(async () => {
    const ui = (await (await fetch('/api/copy')).json()).ui as Record<string, string>
    const texts = ['verdict.red', 'verdict.amber', 'verdict.partial', 'verdict.ok'].map((k) => ui[k].replace('{n}', '১২'))
    const box = document.createElement('div'); box.className = 'mx-auto max-w-2xl px-4'; document.body.appendChild(box)
    return texts.map((text) => {
      const h = document.createElement('h2'); h.className = 'display text-[2rem] sm:text-[2.4rem]'; h.textContent = text
      h.style.lineHeight = '1.2'; box.appendChild(h)
      return { text, lines: Math.round(h.getBoundingClientRect().height / (parseFloat(getComputedStyle(h).fontSize) * 1.2)) }
    })
  })
  for (const l of lines) expect(l.lines, l.text).toBe(1)
})

// The welcome example plays by itself (the story's pairs first) so it draws the eye while the team talks; it can be
// paused, and it never moves for someone who asked the system to reduce motion.
test('welcome example: story pairs first, moves on by itself, can be paused', async ({ page }) => {
  await page.goto('/')
  const card = page.locator('section').first()
  await expect(card.getByText('Napa', { exact: true })).toBeVisible()
  await expect(card.getByText('Paracetamol', { exact: true })).toBeVisible()
  await expect(card.getByText('Alatrol', { exact: true })).toBeVisible({ timeout: 6000 })
  await expect(card.getByText('Cetirizine', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: 'উদাহরণ থামান' }).click()
  const pair = async () => card.locator('.hand').allInnerTexts()
  const paused = await pair()
  await page.waitForTimeout(6000)
  expect(await pair()).toEqual(paused)
  await noSideScroll(page)
})

test('welcome example stays still when the system asks for reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  const card = page.locator('section').first()
  await expect(card.getByText('Napa', { exact: true })).toBeVisible()
  await page.waitForTimeout(6500)
  await expect(card.getByText('Napa', { exact: true })).toBeVisible()
  await expect(card.getByRole('button', { name: 'উদাহরণ থামান' })).toHaveCount(0)
})

// A prescription can be photographed on the spot (camera) or picked from the gallery (one or several saved photos).
test('prescription: take a photo with the camera or pick from the gallery', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'ওষুধের ব্যাগ পরীক্ষা করুন' }).click()
  await page.getByRole('button', { name: /প্রেসক্রিপশন/ }).click()
  const camera = page.getByRole('button', { name: /ক্যামেরায় তুলুন/ })
  const gallery = page.getByRole('button', { name: /গ্যালারি থেকে বাছুন/ })
  await expect(camera).toBeVisible()
  await expect(gallery).toBeVisible()
  for (const b of [camera, gallery]) {
    const lines = await b.evaluate((el) => { const s = el.querySelector('.label') as HTMLElement; return Math.round(s.getBoundingClientRect().height / parseFloat(getComputedStyle(s).lineHeight)) })
    expect(lines, 'button label wraps').toBe(1)
  }
  await expect(page.locator('input[type=file][capture="environment"]')).toHaveCount(2)   // prescription camera + strip
  await expect(page.locator('input[type=file][multiple]')).toHaveCount(1)                // gallery
  await noSideScroll(page)
})

// Several photos are read at the same time, and more can be taken while they are read (onsite request). The server
// is faked here with a slow reply, so the test measures how many photos are in flight together.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC', 'base64')
test('several photos are read at once, and the camera stays usable meanwhile', async ({ page }) => {
  let inFlight = 0, maxInFlight = 0, n = 0
  await page.route('**/images', async (route) => {
    inFlight++; maxInFlight = Math.max(maxInFlight, inFlight)
    const k = ++n
    await new Promise((r) => setTimeout(r, 2500))
    inFlight--
    const item = { item_id: `p${k}`, doc_id: `d${k}`, source: 'strip', reading: `Brand${k}`, alternatives: [], handwritten: false, agree: null,
      chosen: null, confidence: 0, method: 'R2 unsure', needs_confirm: true, options: [], schedule: {}, per_day: null, has_crop: false,
      agent: null, doctor: null, taking: 'unsure' }
    await route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ doc_id: `d${k}`, duplicate_of: null, kind: 'strip', items: [item], request_id: 'x', latency_ms: 1 }) })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'ওষুধের ব্যাগ পরীক্ষা করুন' }).click()
  await page.getByRole('button', { name: /প্রেসক্রিপশন/ }).click()
  await page.locator('input[type=file][multiple]').setInputFiles(
    [1, 2, 3].map((i) => ({ name: `strip${i}.png`, mimeType: 'image/png', buffer: PNG })))
  await expect(page.getByText(/ছবি ৩: পড়া হচ্ছে/)).toBeVisible()
  await expect(page.getByRole('button', { name: /স্ট্রিপ বা বাক্স/ })).toBeEnabled()          // can take another photo now
  await expect(page.getByRole('button', { name: /মিলিয়ে দেখুন/ })).toBeDisabled()            // but not check yet
  await expect(page.getByText(/৩টি ছবি পড়া শেষ/)).toBeVisible({ timeout: 10000 })
  expect(maxInFlight, 'photos read one after another').toBeGreaterThanOrEqual(3)
  await expect(page.getByRole('article')).toHaveCount(3)
  await noSideScroll(page)
})

// Camera: one photo per opening (a phone limit), so after each photo one tap opens the camera again; earlier photos
// keep being read meanwhile.
test('camera: take photo after photo without waiting', async ({ page }) => {
  await page.route('**/images', async (route) => {
    await new Promise((r) => setTimeout(r, 3000))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ doc_id: 'd', duplicate_of: null, kind: 'strip', items: [], request_id: 'x', latency_ms: 1 }) })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'ওষুধের ব্যাগ পরীক্ষা করুন' }).click()
  await page.getByRole('button', { name: /প্রেসক্রিপশন/ }).click()
  let chooser = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: /ক্যামেরায় তুলুন/ }).click()
  await (await chooser).setFiles({ name: 'a.png', mimeType: 'image/png', buffer: PNG })
  const again = page.getByRole('button', { name: /আরেকটা ছবি তুলুন/ })
  await expect(again).toBeVisible()
  chooser = page.waitForEvent('filechooser')
  await again.click()
  const fc = await chooser
  expect(await fc.element().getAttribute('capture')).toBe('environment')
  await fc.setFiles({ name: 'b.png', mimeType: 'image/png', buffer: PNG })
  await expect(page.getByText(/ছবি ২: পড়া হচ্ছে/)).toBeVisible()
  await noSideScroll(page)
})

test('the result is one verdict for the whole bag', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'নমুনা দেখুন' }).click()
  await page.getByRole('button', { name: /মিলিয়ে দেখুন/ }).click()
  await expect(page.getByText('পুরো ব্যাগের ফল', { exact: true })).toBeVisible()
})

// Not sure -> the family types the name: only what they typed is listed (Bicozin first, not the earlier Bilastin
// guesses); a name our registry does not have can be looked up on MedEx and added with its source.
test('typing a name lists it first; a missing brand can be looked up on MedEx', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'ওষুধের ব্যাগ পরীক্ষা করুন' }).click()
  await page.getByRole('button', { name: /লিখে দিন/ }).click()
  await page.locator('textarea').fill('Bicotin\nItracare SB')
  await page.getByRole('button', { name: /যোগ করুন/ }).first().click()
  const first = page.getByRole('article').first()
  await first.getByRole('button', { name: /কোনোটিই নয়/ }).click()
  await first.locator('input').fill('Bicozin')
  const options = first.locator('button.print')
  await expect(options.first()).toContainText('Bicozin')
  await expect(first.getByText(/Bilastin/)).toHaveCount(0)

  await page.route('**/api/brands/web?**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
    results: [{ brand: 'Itracare SB', form: 'Capsule', generic: 'Itraconazole', strength: '65 mg', maker: 'Delta Pharma PLC.',
      url: 'https://medex.com.bd/brands/38174/itracare-sb-65-mg-capsule' }], via: 'medex', request_id: 'x', latency_ms: 1 }) }))
  const second = page.getByRole('article').nth(1)
  await second.getByRole('button', { name: /কোনোটিই নয়/ }).click()
  await second.locator('input').fill('Itracare SB')
  await second.getByRole('button', { name: /ইন্টারনেটে খুঁজুন/ }).click()
  await expect(second.getByText('ভেতরে: Itraconazole')).toBeVisible()
  await expect(second.getByRole('link', { name: /উৎস: MedEx/ })).toHaveAttribute('href', /medex\.com\.bd\/brands\/38174/)
  await noSideScroll(page)
})

// The voice reply is prepared as soon as the result appears, so tapping শুনুন does not wait for it.
test('the spoken reply is prepared before the tap', async ({ page }) => {
  let asked = 0
  await page.route('**/speech', (r) => { asked++; return r.fulfill({ status: 200, contentType: 'audio/wav', body: Buffer.alloc(64) }) })
  await page.goto('/')
  await page.getByRole('button', { name: 'নমুনা দেখুন' }).click()
  await page.getByRole('button', { name: /মিলিয়ে দেখুন/ }).click()
  await expect(page.getByText('পুরো ব্যাগের ফল', { exact: true })).toBeVisible()
  await expect.poll(() => asked, { timeout: 5000 }).toBeGreaterThanOrEqual(1)
})

test('the app name in the top bar goes back to the first page', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'নমুনা দেখুন' }).click()
  await expect(page.getByRole('article').first()).toBeVisible()
  await page.getByRole('button', { name: 'প্রথম পাতায় যান' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('button', { name: 'ওষুধের ব্যাগ পরীক্ষা করুন' })).toBeVisible()
})

// 24 Nov on the phone: opening the camera while a prescription was read dropped that connection; the server had read
// and saved it, the phone never heard and looked stuck. The app now asks the case what each upload gave.
test('a photo whose answer is lost still shows its medicines (connection dropped, server saved it)', async ({ page }) => {
  let uploadId = ''
  await page.route('**/images', async (route) => {
    const body = route.request().postDataBuffer()?.toString('latin1') ?? ''
    uploadId = /name="upload_id"\r\n\r\n([^\r]+)/.exec(body)?.[1] ?? ''
    await route.abort('connectionreset')
  })
  await page.route(/\/api\/cases\/[^/]+$/, async (route) => {
    if (route.request().method() !== 'GET' || !uploadId) return route.continue()
    const item = { item_id: 'I1', doc_id: 'D1', source: 'rx', reading: 'Exium', alternatives: [], handwritten: true, agree: null,
      chosen: { product_id: 1, brand: 'Exium', strength: '20 mg', form: 'Capsule', maker: 'Radiant', applied: false, web: null },
      confidence: 0.99, method: 'R2', needs_confirm: false, options: [], schedule: {}, per_day: null, has_crop: false, agent: null,
      doctor: 'Dr A', taking: 'unsure' }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ case_id: 'x', items: [item],
      uploads: { [uploadId]: { doc_id: 'D1', duplicate_of: null, items: ['I1'] } }, request_id: 'x', latency_ms: 1 }) })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'ওষুধের ব্যাগ পরীক্ষা করুন' }).click()
  await expect(page).toHaveURL(/\?case=/)                                   // a reload brings the case back
  await page.getByRole('button', { name: /প্রেসক্রিপশন/ }).click()
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'rx.png', mimeType: 'image/png', buffer: PNG })
  await expect(page.getByRole('article')).toHaveCount(1, { timeout: 10000 })
  await expect(page.getByText(/পৌঁছায়নি/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /মিলিয়ে দেখুন/ })).toBeEnabled()
})

// Race: an older copy of the case (asked for while photo A's connection broke) must not wipe the cards photo B added
// meanwhile. 24 Nov: two prescriptions and then the bag, quickly; one prescription's cards never appeared.
test('a late copy of the case never removes cards that arrived meanwhile', async ({ page }) => {
  const card = (id: string, brand: string) => ({ item_id: id, doc_id: id, source: 'rx', reading: brand, alternatives: [], handwritten: true,
    agree: null, chosen: { product_id: 1, brand, strength: '10 mg', form: 'Tablet', maker: 'X', applied: false, web: null }, confidence: 0.99,
    method: 'R2', needs_confirm: false, options: [], schedule: {}, per_day: null, has_crop: false, agent: null, doctor: 'Dr', taking: 'unsure' })
  const ids: string[] = []
  await page.route('**/images', async (route) => {
    const body = route.request().postDataBuffer()?.toString('latin1') ?? ''
    const id = /name="upload_id"\r\n\r\n([^\r]+)/.exec(body)?.[1] ?? ''
    ids.push(id)
    if (ids.length === 1) return route.abort('connectionreset')                    // photo A: connection lost
    await new Promise((r) => setTimeout(r, 400))                                   // photo B: answers while the copy is on its way
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ doc_id: 'D2', duplicate_of: null, kind: 'prescription',
      items: [card('I2', 'Alatrol')], request_id: 'x', latency_ms: 1 }) })
  })
  await page.route(/\/api\/cases\/[^/]+$/, async (route) => {
    if (route.request().method() !== 'GET' || !ids.length) return route.continue()
    await new Promise((r) => setTimeout(r, 1500))                                  // the copy is slow: taken before B finished
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ case_id: 'x', items: [card('I1', 'Des')],
      uploads: { [ids[0]]: { doc_id: 'D1', duplicate_of: null, items: ['I1'] } }, request_id: 'x', latency_ms: 1 }) })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'ওষুধের ব্যাগ পরীক্ষা করুন' }).click()
  await page.getByRole('button', { name: /প্রেসক্রিপশন/ }).click()
  await page.locator('input[type=file][multiple]').setInputFiles([1, 2].map((i) => ({ name: `rx${i}.png`, mimeType: 'image/png', buffer: PNG })))
  await page.waitForTimeout(4000)
  await expect(page.getByRole('article')).toHaveCount(2)
  await expect(page.getByRole('article').filter({ hasText: 'Alatrol' })).toHaveCount(1)
})

const fakeCard = (id: string, brand: string, source = 'rx', needs = false) => ({ item_id: id, doc_id: source === 'voice' ? null : id, source,
  reading: brand, alternatives: [], handwritten: source === 'rx', agree: null,
  chosen: { product_id: 1, brand, strength: '10 mg', form: 'Tablet', maker: 'X', applied: false, web: null }, confidence: 0.99, method: 'R2',
  needs_confirm: needs, options: needs ? [{ product_id: 1, brand, strength: '10 mg', form: 'Tablet', maker: 'X' }] : [], schedule: {}, per_day: null,
  has_crop: false, agent: null, doctor: 'Dr', taking: 'unsure' })

// Android can reload the page after the camera. A photo the server is still reading must still arrive on screen,
// and the bag must not be checked before it does.
test('after a reload, a photo the server is still reading still arrives, and checking waits for it', async ({ page }) => {
  let calls = 0
  await page.route(/\/api\/cases\/x1$/, async (route) => {
    calls += 1
    const done = calls >= 3
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ case_id: 'x1',
      items: done ? [fakeCard('I1', 'Des'), fakeCard('I2', 'Exium')] : [fakeCard('I1', 'Des')],
      uploads: { u9: done ? { state: 'done', doc_id: 'D2', duplicate_of: null, items: ['I2'] } : { state: 'reading', doc_id: null, duplicate_of: null, items: [] } },
      request_id: 'x', latency_ms: 1 }) })
  })
  await page.goto('/?case=x1')
  await expect(page.getByText(/এখনো পড়া হচ্ছে/)).toBeVisible()
  await expect(page.getByRole('button', { name: /মিলিয়ে দেখুন/ })).toBeDisabled()
  await expect(page.getByRole('article').filter({ hasText: 'Exium' })).toHaveCount(1, { timeout: 15000 })
  await expect(page.getByText(/এখনো পড়া হচ্ছে/)).toHaveCount(0)
  await expect(page.getByRole('button', { name: /মিলিয়ে দেখুন/ })).toBeEnabled()
})

// A copy of the case fetched while photos are read must never bring back a card the family removed.
test('a removed card stays removed while photos are still being read', async ({ page }) => {
  await page.route('**/images', async (route) => { await new Promise((r) => setTimeout(r, 20000)); await route.abort('connectionreset') })
  await page.route(/\/api\/cases\/[^/]+\/items\/I1$/, (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"ok":true}' }))
  await page.route(/\/api\/cases\/[^/]+$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue()
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ case_id: 'x', items: [fakeCard('I1', 'Des')],
      uploads: {}, request_id: 'x', latency_ms: 1 }) })
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'ওষুধের ব্যাগ পরীক্ষা করুন' }).click()
  await page.getByRole('button', { name: /প্রেসক্রিপশন/ }).click()
  await page.locator('input[type=file][multiple]').setInputFiles({ name: 'rx.png', mimeType: 'image/png', buffer: PNG })
  await expect(page.getByRole('article').filter({ hasText: 'Des' })).toHaveCount(1, { timeout: 10000 })   // brought by the case copy
  await page.getByRole('button', { name: 'বাদ দিন: Des' }).click()
  await page.waitForTimeout(10000)                                        // past the undo window and two more copies
  await expect(page.getByRole('article').filter({ hasText: 'Des' })).toHaveCount(0)
})

// 24 Nov: deleting cards quickly, they did not go away at once (and one came back). A deleted card leaves at once.
test('deleting cards one after another removes each at once', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'ওষুধের ব্যাগ পরীক্ষা করুন' }).click()
  await page.getByRole('button', { name: /লিখে দিন/ }).first().click()
  await page.locator('#typed').fill('Napa 500\nAce 500\nSeclo 20')
  await page.getByRole('button', { name: /যোগ করুন/ }).click()
  await expect(page.getByRole('article')).toHaveCount(3, { timeout: 15000 })
  for (const [brand, left] of [['Napa', 2], ['Ace', 1]] as const) {
    await page.getByRole('button', { name: `বাদ দিন: ${brand}` }).click()
    await expect(page.getByRole('article')).toHaveCount(left, { timeout: 300 })
  }
  await page.waitForTimeout(6000)
  await expect(page.getByRole('article')).toHaveCount(1)
})

// A delete lost on a flaky connection was ignored: the server kept the medicine and the check still warned about it.
test('a deleted medicine is not in the check even if the first delete request was lost', async ({ page }) => {
  let deletes = 0
  await page.route(/\/api\/cases\/[^/]+\/items\/[^/]+$/, async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue()
    deletes += 1
    if (deletes === 1) return route.abort('connectionreset')
    return route.continue()
  })
  await page.goto('/')
  await page.getByRole('button', { name: 'ওষুধের ব্যাগ পরীক্ষা করুন' }).click()
  await page.getByRole('button', { name: /লিখে দিন/ }).first().click()
  await page.locator('#typed').fill('Napa 500\nSeclo 20')
  await page.getByRole('button', { name: /যোগ করুন/ }).click()
  await expect(page.getByRole('article')).toHaveCount(2, { timeout: 15000 })
  await page.getByRole('button', { name: 'বাদ দিন: Napa' }).click()
  await page.getByRole('button', { name: /মিলিয়ে দেখুন/ }).click()
  await expect(page.getByText('Seclo').first()).toBeVisible({ timeout: 20000 })
  await expect(page.getByText('Napa')).toHaveCount(0)
})

import { getStore } from "@netlify/blobs"
import type { Config, Context } from "@netlify/functions"

// Sign-ups for the 2026 Potluck.
// One blob per RSVP ("rsvp/<id>") plus an email index ("email/<sha256>") so concurrent
// sign-ups never overwrite each other and duplicate emails are rejected atomically.
// Guests see first names + dishes only; emails come back only with the host passcode.

const CATEGORIES = ["mains", "sides", "apps", "salads", "breads", "desserts"]
const TAGS = ["Vegetarian", "Vegan", "Gluten-Free", "Dairy-Free", "Contains Nuts"]

// Placeholder sign-ups so the board isn't empty at launch.
// Marked sample: true and using reserved example.com emails (never a real person).
// They are seeded once; "Remove sample entries" in the Host Tracker deletes only these,
// and they never come back. Real sign-ups can never carry the sample flag.
const SAMPLES = [
  { n: 1, name: "Jordan Taylor", unit: "404", email: "jordan.taylor@example.com", partySize: 1, category: "mains", dish: "Baked Ziti", tags: [] },
  { n: 2, name: "Maya Patel", unit: "314", email: "maya.patel@example.com", partySize: 2, category: "apps", dish: "Wegmans Charcuterie & Fig Jam Board", tags: ["Contains Nuts"] },
  { n: 3, name: "Chris & Sam", unit: "608", email: "chris.sam@example.com", partySize: 2, category: "sides", dish: "Garlic Parmesan Mashed Potatoes", tags: ["Vegetarian", "Gluten-Free"] },
  { n: 4, name: "Elena Morales", unit: "422", email: "elena.m@example.com", partySize: 1, category: "desserts", dish: "Peppermint Chocolate Bark & Sugar Cookies", tags: ["Vegetarian"] },
  { n: 5, name: "Devon Brooks", unit: "205", email: "devon.brooks@example.com", partySize: 2, category: "salads", dish: "Winter Kale, Apple & Pecan Salad", tags: ["Vegan", "Gluten-Free", "Contains Nuts"] },
]

async function ensureSamplesSeeded() {
  const s = store()
  const { modified } = await s.set("meta/samples-seeded", new Date().toISOString(), { onlyIfNew: true })
  if (!modified) return
  const base = Date.UTC(2026, 10, 20)
  await Promise.all(SAMPLES.map(({ n, ...r }) =>
    s.setJSON(`rsvp/rsvp-sample-${n}`, { id: `rsvp-sample-${n}`, ...r, sample: true, createdAt: base + n * 3600000 })))
}

const store = () => getStore({ name: "potluck-rsvps", consistency: "strong" })

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function isHost(req: Request) {
  const key = Netlify.env.get("HOST_KEY")
  const given = req.headers.get("x-host-key") || ""
  return !!key && given.length > 0 && given === key
}

function clean(v: unknown, max: number) {
  return String(v ?? "").replace(/[\u0000-\u001f]/g, " ").trim().slice(0, max)
}

function publicView(r: any) {
  return {
    id: r.id,
    name: String(r.name || "").split(/\s+/)[0],
    partySize: r.partySize,
    category: r.category,
    dish: r.dish,
    tags: r.tags || [],
    createdAt: r.createdAt,
  }
}

async function allRsvps() {
  const s = store()
  const { blobs } = await s.list({ prefix: "rsvp/" })
  const rows = await Promise.all(blobs.map((b) => s.get(b.key, { type: "json" })))
  return rows.filter(Boolean).sort((a: any, b: any) => (b.createdAt || 0) - (a.createdAt || 0))
}

const json = (data: unknown, status = 200) =>
  Response.json(data, { status, headers: { "cache-control": "no-store" } })

export default async (req: Request, context: Context) => {
  try {
    await ensureSamplesSeeded()

    if (req.method === "GET") {
      const rows = await allRsvps()
      const host = new URL(req.url).searchParams.get("host") === "1"
      if (host) {
        if (!isHost(req)) return json({ error: "Wrong host passcode." }, 401)
        return json({ rsvps: rows })
      }
      return json({ rsvps: rows.map(publicView) })
    }

    if (req.method === "POST") {
      let body: any
      try { body = await req.json() } catch { return json({ error: "Invalid request." }, 400) }
      const name = clean(body.name, 80)
      const dish = clean(body.dish, 120)
      const residency = body.residency === "guest" ? "guest" : body.residency === "resident" ? "resident" : ""
      const unit = residency === "guest" ? "" : clean(body.unit, 20)
      const invitedBy = residency === "guest" ? clean(body.invitedBy, 80) : ""
      const email = clean(body.email, 160).toLowerCase()
      const category = CATEGORIES.includes(body.category) ? body.category : "mains"
      const tags = Array.isArray(body.tags) ? body.tags.filter((t: string) => TAGS.includes(t)) : []
      const partySize = Math.max(1, Math.min(10, parseInt(body.partySize, 10) || 1))
      if (!name || !dish) return json({ error: "Please enter both your name and the dish you plan to bring." }, 400)
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Please enter a valid email address." }, 400)
      if (residency === "resident" && !unit) return json({ error: "Please enter your apartment number." }, 400)

      const s = store()
      const id = "rsvp-" + Date.now().toString(36) + "-" + crypto.randomUUID().slice(0, 8)
      const emailKey = "email/" + (await sha256(email))
      const claim = await s.set(emailKey, id, { onlyIfNew: true })
      if (!claim.modified) {
        const existingId = await s.get(emailKey)
        const existing: any = existingId ? await s.get("rsvp/" + existingId, { type: "json" }) : null
        return json({ error: "duplicate", existing: existing ? { dish: existing.dish, category: existing.category, name: publicView(existing).name } : null }, 409)
      }
      const entry = { id, name, unit, residency, invitedBy, email, partySize, category, dish, tags, createdAt: Date.now() }
      await s.setJSON("rsvp/" + id, entry)
      return json({ rsvp: publicView(entry) }, 201)
    }

    if (req.method === "DELETE") {
      if (!isHost(req)) return json({ error: "Wrong host passcode." }, 401)
      if (new URL(req.url).searchParams.get("samples") === "1") {
        const s = store()
        const samples = (await allRsvps()).filter((r: any) => r.sample === true)
        await Promise.all(samples.map((r: any) => s.delete("rsvp/" + r.id)))
        return json({ ok: true, removed: samples.length })
      }
      const id = clean(new URL(req.url).searchParams.get("id"), 80)
      if (!/^rsvp-[a-z0-9-]+$/.test(id)) return json({ error: "Invalid id." }, 400)
      const s = store()
      const entry: any = await s.get("rsvp/" + id, { type: "json" })
      if (entry) {
        await s.delete("rsvp/" + id)
        if (entry.email) await s.delete("email/" + (await sha256(entry.email)))
      }
      return json({ ok: true })
    }

    return json({ error: "Method not allowed." }, 405)
  } catch (err) {
    console.error("rsvps function error", err)
    return json({ error: "The sign-up list is temporarily unavailable. Please try again." }, 500)
  }
}

export const config: Config = { path: "/api/rsvps", method: ["GET", "POST", "DELETE"] }

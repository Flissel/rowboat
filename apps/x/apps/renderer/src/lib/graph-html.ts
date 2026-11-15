// HTML-Konzepte im Wissensgraphen: Text für den [[…]]-Leser, Knotennamen, HTML-Dateien, Verweise ohne Endung.
import { konzept } from '@x/shared'
import { wikiLinkTargets } from './graph-hierarchy'
import { normalizeWikiPath, splitWikiFragment, toKnowledgePath, wikiLabel } from './wiki-links'

/**
 * Text einer HTML-Datei für den vorhandenen [[…]]-Leser des Graphen: die bezuege des Datenblocks plus der sichtbare
 * Text (ohne Skripte, Stile, Kommentare). Beides höchstens KONZEPT_LESE_MAX Zeichen aus dem Dateitext.
 */
export function graphHtmlData(raw: string): string {
  const capped = raw.length > konzept.KONZEPT_LESE_MAX ? raw.slice(0, konzept.KONZEPT_LESE_MAX) : raw
  const bezuege = konzept.readKonzept(capped).daten?.bezuege.join(' ') ?? ''
  return `${bezuege} ${konzept.htmlVisibleText(capped)}`
}

/** Anzeigename eines Knotens (reiner Text, kein Markup): bei HTML der <title> oder der Dateiname ohne Endung. */
export function graphNodeLabel(path: string, data: string): string {
  if (konzept.isHtmlPath(path)) {
    const name = path.replace(/\\/g, '/').split('/').pop() ?? path
    return konzept.htmlTitle(data) || name.replace(/\.(html?|xhtml)$/i, '') || path
  }
  return wikiLabel(path) || path
}

/**
 * Eine HTML-Datei für den Graphen: Link-Text (graphHtmlData) und Name zusammen aus dem ROHEN, gekappten HTML.
 * Der Name kommt nie aus dem tag-losen Link-Text (dort wären entschlüsselte Entitäten als <title> lesbar).
 */
export function graphHtmlNode(path: string, raw: string): { data: string; label: string } {
  const capped = raw.length > konzept.KONZEPT_LESE_MAX ? raw.slice(0, konzept.KONZEPT_LESE_MAX) : raw
  return { data: graphHtmlData(capped), label: graphNodeLabel(path, capped) }
}

/** HTML-Dateien unter knowledge/ aus der Baumliste, ohne Präfix und mit Endung (damit [[…x.html]] auflöst). */
export function knowledgeHtmlFiles(treePaths: string[]): string[] {
  return Array.from(new Set(
    treePaths.filter((p) => konzept.isKnowledgeHtmlPath(p)).map((p) => p.replace(/^knowledge\//, '')),
  ))
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** Beschriftung für Senken, die HTML erwarten (react-force-graph `nodeLabel`/`linkLabel`). */
export function graphLabelHtml(name: string): string {
  return escapeHtml(name)
}

/** Ein Link auf eine nicht vorhandene HTML-Datei darf keine Markdown-Notiz in einen HTML-Pfad schreiben. */
export function canCreateWikiTarget(path: string): boolean {
  return !konzept.isHtmlPath(path)
}

const HTML_ENDUNGEN = ['.html', '.htm', '.xhtml']

/** Dateiname ohne Ordner und ohne `.md`- bzw. HTML-Endung. */
function nameOhneEndung(path: string): string {
  const name = path.replace(/\\/g, '/').split('/').pop() ?? path
  return name.replace(/\.(md|html?|xhtml)$/i, '')
}

/**
 * Verweis -> Knoten-Pfad. Mit Endung wie bisher (toKnowledgePath). Ohne Endung: `x.md`, wenn es existiert; sonst
 * genau eine von `x.html`/`x.htm`/`x.xhtml`, wenn nur eine existiert; sonst, bei einem Verweis ohne Ordner und mit
 * `kandidaten` (alle bekannten Wissens-Pfade), die eine HTML-Datei gleichen Namens, wenn der Name unter allen
 * Kandidaten (Notizen und HTML) genau einmal vorkommt; sonst wie bisher (`x.md`, also unaufgelöst, wenn es fehlt).
 */
export function resolveWikiTarget(
  raw: string,
  exists: (knowledgePath: string) => boolean,
  kandidaten: readonly string[] = [],
): string | null {
  const standard = toKnowledgePath(raw)
  if (!standard) return null
  const base = splitWikiFragment(normalizeWikiPath(raw)).path
  if (standard !== `knowledge/${base}.md` || base.toLowerCase().endsWith('.md')) return standard
  if (exists(standard)) return standard
  const hits = HTML_ENDUNGEN.map((e) => `knowledge/${base}${e}`).filter(exists)
  if (hits.length === 1) return hits[0]
  if (hits.length === 0 && !base.includes('/')) {
    const gleichnamig = kandidaten.filter((p) => nameOhneEndung(p) === base)
    if (gleichnamig.length === 1 && konzept.isKnowledgeHtmlPath(gleichnamig[0]) && exists(gleichnamig[0])) {
      return gleichnamig[0]
    }
  }
  return standard
}

// ---- Zwei Graphen: Konzepte (mit Notizen als Bezug) und Notizen (mit Konzepten als Bezug) ----

export type KonzeptKnoten = { id: string; label: string; art: 'konzept' | 'videokonzept' | 'html' | 'notiz' }
export type KonzeptKante = { source: string; target: string; kind: 'verweis' }

/**
 * Der Konzepte-Graph. Hauptknoten: jede HTML-Datei aus `eintraege` (Name aus `<title>`, sonst Dateiname; Art aus dem
 * Datenblock, ohne lesbaren Block `html`; eine nicht gelesene Datei kommt mit leerem `html`). Nebenknoten (`notiz`):
 * jede Notiz, auf die ein Konzept verweist (bezuege oder Verweise im sichtbaren Text) oder die auf ein Konzept verweist
 * (`notizen[].ziele`, die schon gelesenen `[[…]]`-Ziele). Kanten `verweis` in Richtung des Verweises; doppelte
 * zusammengefasst, Selbstbezüge und unaufgelöste Ziele (`resolve` -> null) entfallen. Ordnung: Knoten nach id,
 * Kanten nach source, target, kind. Alle Namen sind reiner Text.
 */
export function buildKonzeptGraph(
  eintraege: { pfad: string; html: string }[],
  notizen: { pfad: string; ziele: string[] }[],
  resolve: (ziel: string) => string | null,
  istKonzept: (pfad: string) => boolean,
): { nodes: KonzeptKnoten[]; edges: KonzeptKante[] } {
  const knoten = new Map<string, KonzeptKnoten>()
  for (const { pfad, html } of eintraege) {
    const capped = html.length > konzept.KONZEPT_LESE_MAX ? html.slice(0, konzept.KONZEPT_LESE_MAX) : html
    const art = konzept.readKonzept(capped).daten?.art ?? 'html'
    knoten.set(pfad, { id: pfad, label: graphNodeLabel(pfad, capped), art })
  }
  const kanten = new Map<string, KonzeptKante>()
  const notizKnoten = (pfad: string) => {
    if (!knoten.has(pfad)) knoten.set(pfad, { id: pfad, label: graphNodeLabel(pfad, ''), art: 'notiz' })
  }
  const kante = (source: string, target: string) => {
    if (source !== target) kanten.set(`${source}\u0000${target}`, { source, target, kind: 'verweis' })
  }
  const konzeptPfade = new Set(eintraege.map((e) => e.pfad))
  for (const { pfad, html } of eintraege) {
    for (const roh of wikiLinkTargets(graphHtmlData(html))) {
      const ziel = resolve(roh)
      if (ziel === null || ziel === pfad) continue
      if (istKonzept(ziel)) {
        if (konzeptPfade.has(ziel)) kante(pfad, ziel)
      } else {
        notizKnoten(ziel)
        kante(pfad, ziel)
      }
    }
  }
  for (const { pfad, ziele } of notizen) {
    if (konzeptPfade.has(pfad)) continue
    for (const roh of ziele) {
      const ziel = resolve(roh)
      if (ziel === null || ziel === pfad || !istKonzept(ziel) || !konzeptPfade.has(ziel)) continue
      notizKnoten(pfad)
      kante(pfad, ziel)
    }
  }
  const vor = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
  return {
    nodes: [...knoten.values()].sort((a, b) => vor(a.id, b.id)),
    edges: [...kanten.values()].sort((a, b) => vor(a.source, b.source) || vor(a.target, b.target) || vor(a.kind, b.kind)),
  }
}

/** Konzepte, die im Notizen-Graphen als Nebenknoten bleiben: mit mindestens einer Kante zu einer Notiz (Richtung egal). */
export function konzepteMitNotizBezug(
  kanten: readonly { source: string; target: string }[],
  istKonzept: (pfad: string) => boolean,
): Set<string> {
  const out = new Set<string>()
  for (const { source, target } of kanten) {
    const s = istKonzept(source)
    const t = istKonzept(target)
    if (s && !t) out.add(source)
    if (t && !s) out.add(target)
  }
  return out
}

/**
 * Der Notizen-Graph aus dem heutigen Graphen: alle Notizen, Konzepte nur mit Notiz-Bezug ({@link konzepteMitNotizBezug}),
 * ohne Kanten zwischen zwei Konzepten. Reihenfolge der Eingabe bleibt.
 */
export function notizGraph<K extends { source: string; target: string }>(
  pfade: readonly string[],
  kanten: readonly K[],
  istKonzept: (pfad: string) => boolean,
): { pfade: string[]; kanten: K[] } {
  const bleiben = konzepteMitNotizBezug(kanten, istKonzept)
  return {
    pfade: pfade.filter((p) => !istKonzept(p) || bleiben.has(p)),
    kanten: kanten.filter((k) => !(istKonzept(k.source) && istKonzept(k.target))),
  }
}

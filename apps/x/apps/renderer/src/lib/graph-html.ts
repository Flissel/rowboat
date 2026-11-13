// HTML-Konzepte im Wissensgraphen: kappt den Dateitext, benennt Knoten, listet HTML-Dateien.
// Die Kanten kommen aus dem vorhandenen [[…]]-Leser in graph-hierarchy (bezuege stehen als "[[…]]" im Datenblock).
import { konzept } from '@x/shared'
import { wikiLabel } from './wiki-links'

/** Höchstens KONZEPT_LESE_MAX Zeichen des Dateitexts: große fremde HTML-Dateien bremsen den Graphen nicht. */
export function graphHtmlData(raw: string): string {
  return raw.length > konzept.KONZEPT_LESE_MAX ? raw.slice(0, konzept.KONZEPT_LESE_MAX) : raw
}

/** Anzeigename eines Knotens: bei HTML der <title> oder der Dateiname ohne Endung, sonst wie bisher. */
export function graphNodeLabel(path: string, data: string): string {
  if (konzept.isHtmlPath(path)) return konzept.htmlTitle(data) || wikiLabel(path) || path
  return wikiLabel(path) || path
}

/** HTML-Dateien unter knowledge/ aus der Baumliste, ohne Präfix und mit Endung (damit [[…x.html]] auflöst). */
export function knowledgeHtmlFiles(treePaths: string[]): string[] {
  return Array.from(new Set(
    treePaths.filter((p) => konzept.isKnowledgeHtmlPath(p)).map((p) => p.replace(/^knowledge\//, '')),
  ))
}

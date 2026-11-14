import { WORKSPACE_HTML_CSP } from '@x/shared/dist/konzept.js';
import { VIDEOKONZEPT_VORLAGE } from './vorlage.js';

// Instructions are in English like the neighbouring bundled skills; everything
// the user sees (example texts, the page template) stays German.
export const skill = `
# Concepts (single-file HTML pages)

Load this skill when the user asks for a **Konzept, Videokonzept, "als Seite", HTML-Seite or Konzept-Canvas** — a clickable page that lays out an idea, plan, structure or video concept visually. Writing ordinary notes stays with \`doc-collab\`.

A concept is ONE self-contained \`.html\` file in the knowledge folder. Rowboat shows it in a pane next to the chat and reloads it whenever the file changes. It is also a node in the knowledge graph, searchable and versioned.

## Hard rules

1. **Location:** \`knowledge/Konzepte/<Name>.html\` (create the folder with \`file-mkdir\` if needed). Short German name, no slashes. **Never** put a concept under \`knowledge/Kanal/\`.
2. **One file, at most 1 MB (1,048,576 bytes).** Nothing from the network: no external scripts, styles, fonts, images, iframes or fetches. Images only as \`data:\` URIs (keep them small — they count towards the 1 MB).
3. **The page runs sandboxed.** It is served with this rule: \`${WORKSPACE_HTML_CSP}\`. So: inline \`<script>\` and \`<style>\` only; no \`eval\`, no \`new Function\`; no forms that submit.
4. **Plain links do not work** — neither \`<a href>\` navigation nor \`target="_blank"\`. Links work only as messages from a click handler (see "Links" below).
5. **Order inside the file:** \`<title>\` → data block → \`<style>\` → content → \`<script>\`.
6. **Never invent people or details.** Use no names, contact data or customer details the user did not explicitly give you.
7. **Do not open the file yourself.** The pane opens and reloads by itself when you write or edit a \`knowledge/**.html\` file. Do not call \`app-navigation\`. After writing, say in ONE sentence what you made or changed. Never paste the HTML into the chat.

## The data block

Every concept carries exactly one data block, right after \`<title>\`:

\`\`\`html
<script type="application/json" id="rowboat-konzept">
{ "art": "konzept", "bezuege": ["[[Marke/Marke]]"] }
</script>
\`\`\`

- \`art\` is \`"konzept"\` (general) or \`"videokonzept"\`.
- \`bezuege\` lists EVERY note the concept uses, as strings with double square brackets, written like wiki links: path relative to \`knowledge/\`, without \`.md\` (\`"[[Marke/Marke]]"\`). That is what puts the concept into the graph and keeps references alive on rename. An HTML target keeps its extension. No reference → \`[]\`.
- Maximum 20,000 characters. Valid JSON only.
- It sits inside a \`<script>\`, so write \`</script\` as \`<\\/script\` inside text; you may also write \`<\`, \`>\`, \`&\` as \`\\u003c\`, \`\\u003e\`, \`\\u0026\`. The page's own script reads the block with \`JSON.parse(document.getElementById('rowboat-konzept').textContent)\`.

## Links (click handlers only)

The page cannot navigate. It asks the viewer, which shows a confirmation the user must click. The page gets no answer.

- **Note:** \`parent.postMessage({ type: 'rowboat:notiz-oeffnen', pfad: 'knowledge/Marke/Marke.md' }, '*')\` — path under \`knowledge/\`, with extension. Add a button for every note in \`bezuege\`; turn \`[[Marke/Marke]]\` into \`knowledge/Marke/Marke.md\` (keep \`.html\`/\`.htm\`/\`.xhtml\` when the entry already has it).
- **Web address (http/https only):** \`parent.postMessage({ type: 'rowboat:link-oeffnen', url: 'https://…' }, '*')\` from a real \`<button>\` whose click handler sends it. Show the address as visible text so the user knows where it goes. Use web addresses only when the user gave them or they are well known.

Build these elements with a \`click\` listener, never with \`href\`.

## Look

- Take colours and typeface from the company's brand knowledge in the knowledge base (search for a brand / Marke note first). If there is none, use a calm default.
- Define colours as CSS variables at the top of \`<style>\` so they can be changed in one place.
- Light and dark via \`prefers-color-scheme\`. Readable from 320 px up to wide screens. System fonts only.

## General concepts (not video)

Write the skeleton yourself, in the order above: \`<title>\`, data block with \`"art": "konzept"\` and \`bezuege\`, \`<style>\`, content, a small \`<script>\` for interaction (tabs, collapsing, notes buttons). Keep the content real and scannable; no filler. No fixed template.

## Video concepts

A video concept has \`"art": "videokonzept"\` and a \`video\` object. **Use the template below and change ONLY the data block** and the title text. The title appears twice, in \`<title>\` and in the page heading \`<h1>\`; change both and keep them identical. Its script draws the whole page from the data block — stages as collapsible sections, scenes as cards, summary, warnings, references.

Limits (the app checks them):
- \`thema\` 3–300 characters; \`zielgruppe\` (at most 300 characters); \`minuten\` 3, 4 or 5 (a whole number); \`hook\`; \`kernaussage\` and \`abschluss\` (together at most 4,000 characters);\`auftrag\` is \`null\` or exactly 8 lowercase hex characters (\`0-9a-f\`, the order number the Werkbank gave back) — write \`null\` yourself and never invent a number.
- \`stufen\`: at most 8, each \`{ "name", "szenen": [...] }\`. Scenes **8 to 15 in total** across all stages.
- Scene: \`kurz\` (at most 300 characters), \`bildart\` one of \`slide\`, \`avatar_slide\`, \`avatar_gross\`, \`clip\`, optional \`notiz\` (free text shown under the scene — NOT a reference; a \`[[…]]\` in it stays plain text, so put notes that should be clickable into \`bezuege\`).
- A scene stands for 35–110 spoken words (about 15–45 seconds) that the video pipeline writes LATER — that length is only the planning basis, the words are not part of the concept. \`kurz\` stays a one-to-two sentence summary of at most 300 characters saying what the scene shows and says; never put the script into it. Plan roughly two scenes per minute: 3 min ≈ 8 scenes, 4 min ≈ 8–10, 5 min ≈ 10–12, never outside 8–15. The page shows the possible range against \`minuten\` and warns when the target is outside it.
- If the user wants more (over 15 scenes, over 8 stages, or longer than 5 minutes), stay inside the limits — merge scenes or stages — and name in your one sentence what you cut.

How to write it:
- **Hook:** the result or the surprise first — one or two sentences, no "Hallo und willkommen".
- **Stufen:** 3–5 stages that each move the viewer one step forward.
- **Ehrliche Grenzen:** say what the approach does NOT do or cannot promise.
- **Abschluss:** one clear next step the viewer can take.

### Template

Replace the title text and the JSON between the data-block tags; adapt \`bezuege\`.

` + '```html\n' + VIDEOKONZEPT_VORLAGE + '```' + `

## Changing a concept

- Use \`file-editText\` for every change — a targeted edit, never a full rewrite for a small change. If you did not just write the file yourself, re-read it with \`file-readText\` first (the user may have edited it).
- For a video concept, edit the JSON in the data block ONLY. The template's script redraws the page.
- After an edit, check the data block is still valid JSON and the limits above still hold.

## Handing over to the Werkbank (Übergabe an die Werkbank)

A finished video concept can become an order at the Video-Werkbank, which builds its first outline straight from the concept. Do this **only when the user explicitly asks** (for example "Gib das Konzept an die Werkbank"). Never offer it as a side effect of writing or changing a concept, and never hand over on your own initiative.

1. Make sure the concept is a valid video concept (see the limits above) and saved at \`knowledge/Konzepte/<Name>.html\`.
2. If \`video.auftrag\` is already set, the concept already has an order. Say so in one sentence BEFORE handing over again, with the number, and note that a second handover creates a NEW order. Hand over only if the user still wants that.
3. Call the tool \`rowboat-auftraege:video_auftrag_aus_konzept\` with the concept path in \`pfad\` (for example \`knowledge/Konzepte/KI im Alltag.html\`) and an empty string for \`stand\`. The app fills in \`stand\` itself; never invent a value for it. The tool reads the file itself, so you only pass the path.
4. The app asks the user for a yes before anything is sent. Without that yes there is no order. If the user says no, or the tool returns a refusal or an error sentence, tell the user in one sentence what it said and stop — never try to work around a refusal (no second call, no other tool, no editing the file to get past it).
5. If the tool is not available, say so in one sentence and do not claim a handover happened; do not look for another route. If the call times out or returns no answer, the result is unknown: say so, do not call again, do not write a number, and point the user to the Werkbank page to check whether an order appeared.
6. After success, first tell the user the order number and the link from the answer. The order number is the 8-character \`auftrag\` field of the answer (never the longer \`id\`). Then write that number into the data block with \`file-editText\`: change \`"auftrag": null\` (or the previous number) to \`"auftrag": "<8-character order number>"\` and touch nothing else. Re-read the file with \`file-readText\` first if you did not just write it. If that edit fails, say so; the order exists anyway.

Data protection: what is in the concept goes to the video model and may end up in the video. Never WRITE names, contact data or customer details into a video concept unless the user gave them. If the concept already contains such data, tell the user in one sentence what you found and ask before changing anything; do not edit the concept on your own and do not hand over until the user has decided.

## Before you finish

- [ ] File is \`knowledge/Konzepte/<Name>.html\`, not under \`knowledge/Kanal/\`, one file under 1 MB.
- [ ] Order: \`<title>\` → data block → \`<style>\` → content → \`<script>\`.
- [ ] Data block: \`art\`, \`bezuege\` with \`[[…]]\` for every note used, valid JSON, \`</script\` escaped, at most 20,000 characters (counted as written, including escapes).
- [ ] Nothing external (no http(s) resource, no font, no image URL); images only as \`data:\`.
- [ ] Links and note references are click handlers with \`postMessage\`, no \`href\`/\`target\`.
- [ ] Video concept: template used, only the data block changed, 8–15 scenes, 3–5 minutes, at most 8 stages.
- [ ] Handover only on explicit request; the order number goes into \`video.auftrag\` only after the tool reported success.
- [ ] No names or customer details the user did not give; one sentence to the user, no HTML in the chat, no \`app-navigation\`.
`;

export default skill;

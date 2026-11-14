import { describe, expect, it } from 'vitest';
import skill from './skill.js';

describe('Fähigkeit konzept: Übergabe an die Werkbank (Bestätigung in Sales)', () => {
  const abschnitt = skill.slice(skill.indexOf('## Handing over to the Werkbank'));

  it('hat den Abschnitt (Überschrift mit dem deutschen Namen)', () => {
    expect(skill).toContain('## Handing over to the Werkbank (Übergabe an die Werkbank)');
  });

  it('bereitet nur auf ausdrücklichen Wunsch vor und sagt, dass kein Auftrag entsteht', () => {
    expect(abschnitt).toMatch(/only when the user explicitly asks/i);
    expect(abschnitt).toMatch(/only PREPARED/);
    expect(abschnitt).toMatch(/It does not create an order/);
  });

  it('nennt das Werkzeug mit genau einem Parameter pfad und die zwei Antwortformen', () => {
    expect(abschnitt).toContain('rowboat-auftraege:video_auftrag_aus_konzept');
    expect(abschnitt).toMatch(/ONE parameter: the concept path in \`pfad\`/);
    expect(abschnitt).toContain('"status": "vorbereitet"');
    expect(abschnitt).toContain('"link"');
    expect(abschnitt).toContain('"vorgang"');
    expect(abschnitt).toContain('"fehler"');
  });

  it('negativ: kein stand, keine Ja-Abfrage der App, kein Wiederholen', () => {
    expect(abschnitt).not.toMatch(/\bstand\b/);
    expect(abschnitt).not.toMatch(/asks the user for a yes/i);
    expect(abschnitt).not.toMatch(/the app (fills|asks)/i);
    expect(abschnitt).not.toMatch(/\b(retry it|try again|call it again|call again)\b/i);
    expect(abschnitt).toMatch(/never retry on your own/);
    expect(abschnitt).toMatch(/never try another way to reach the service/);
  });

  it('nach vorbereitet: Nutzer informieren, Bestätigung in Sales, Link, kein Auftrag behaupten', () => {
    expect(abschnitt).toMatch(/On \`vorbereitet\`, tell the user plainly/);
    expect(abschnitt).toContain('erst nach der Bestätigung');
    expect(abschnitt).toMatch(/confirm it on the Sales page/);
    expect(abschnitt).toMatch(/give the link/);
    expect(abschnitt).toMatch(/Do not say that an order exists/);
  });

  it('schreibt direkt nach dem Werkzeugaufruf nichts in video.auftrag', () => {
    expect(abschnitt).toMatch(/do not write anything into \`video\.auftrag\` at this point/);
    // die einzige Schreibanweisung hängt an der Nummer, die der Nutzer nennt
    expect(abschnitt).toMatch(/Only if the user later tells you the order number \(exactly 8 lowercase hex characters\) and asks you to/);
    expect(abschnitt).toContain('file-editText');
    expect(abschnitt).not.toMatch(/After success/i);
    expect(abschnitt).not.toMatch(/first tell the user the order number/);
  });

  it('fehler, Zeitüberschreitung, fehlendes Werkzeug: nichts behaupten, auf Sales verweisen', () => {
    expect(abschnitt).toMatch(/On \`fehler\`, show the user the sentence/);
    expect(abschnitt).toMatch(/not available, say so/);
    expect(abschnitt).toMatch(/times out[^.]*result is unknown[^.]*Sales page/);
    expect(abschnitt).toMatch(/never claim a handover happened/);
  });

  it('weist auf einen vorhandenen Auftrag hin, bevor erneut vorbereitet wird', () => {
    expect(abschnitt).toMatch(/already has an order[\s\S]*BEFORE preparing another handover/);
  });

  it('verbietet Namen, Kontaktdaten und Kundendetails, die der Nutzer nicht genannt hat, und stilles Ändern', () => {
    expect(abschnitt).toMatch(/Never WRITE names, contact data or customer details[^.]*unless the user gave them/);
    expect(abschnitt).toMatch(/ask before changing anything/);
    expect(abschnitt).not.toMatch(/remove any you find/);
  });

  it('beschreibt das Format von auftrag in den Grenzen', () => {
    expect(skill).not.toMatch(/always \`null\`/);
    expect(skill).toMatch(/\`auftrag\` is \`null\` or exactly 8 lowercase hex characters/);
  });
});

import { describe, expect, it } from 'vitest';
import skill from './skill.js';

describe('Fähigkeit konzept: Übergabe an die Werkbank', () => {
  const abschnitt = skill.slice(skill.indexOf('## Handing over to the Werkbank'));

  it('hat den Abschnitt (Überschrift mit dem deutschen Namen)', () => {
    expect(skill).toContain('## Handing over to the Werkbank (Übergabe an die Werkbank)');
  });

  it('übergibt nur auf ausdrücklichen Wunsch', () => {
    expect(abschnitt).toMatch(/only when the user explicitly asks/i);
  });

  it('nennt Werkzeug, Pfad und den Leerstring für stand', () => {
    expect(abschnitt).toContain('rowboat-auftraege:video_auftrag_aus_konzept');
    expect(abschnitt).toMatch(/\`pfad\`/);
    expect(abschnitt).toMatch(/empty string for \`stand\`/);
  });

  it('beschreibt Ja-Abfrage und Verbot, eine Absage zu umgehen', () => {
    expect(abschnitt).toMatch(/asks the user for a yes/i);
    expect(abschnitt).toMatch(/never try to work around a refusal/i);
  });

  it('weist auf einen vorhandenen Auftrag hin, bevor erneut übergeben wird', () => {
    expect(abschnitt).toMatch(/already has an order[\s\S]*BEFORE handing over again/);
  });

  it('trägt die Nummer per file-editText in video.auftrag ein und nennt Nummer und Link', () => {
    expect(abschnitt).toContain('file-editText');
    expect(abschnitt).toContain('video.auftrag');
    expect(abschnitt).toMatch(/order number and the link/i);
  });

  it('verbietet Namen, Kontaktdaten und Kundendetails, die der Nutzer nicht genannt hat', () => {
    expect(abschnitt).toMatch(/no names, contact data or customer details the user did not give/i);
  });

  it('nennt auftrag nicht mehr "always null" und beschreibt das Format', () => {
    expect(skill).not.toMatch(/always \`null\`/);
    expect(skill).toMatch(/\`auftrag\` is \`null\` or exactly 8 lowercase hex characters/);
  });
});

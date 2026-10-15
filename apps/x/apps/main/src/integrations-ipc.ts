// VibeMind: verdrahtet den OpenFang-Integrationen-Client (Core) mit Electron.
// Der OpenFang-Schluessel kommt nur aus process.env.OPENFANG_API_KEY (gesetzt von
// vibemind-os spaces/rowboat/scripts/start_desktop.py) und verlaesst diesen Prozess nie.
import { shell } from 'electron';
import { createOpenFangIntegrations } from '@x/core/dist/integrations/openfang-integrations.js';

const client = createOpenFangIntegrations({
  // Bewusst Nodes globales fetch (undici), NICHT Electrons net.fetch: so greifen weder
  // System-Proxies noch automatische Redirects auf den festen 127.0.0.1-Aufruf.
  fetch: (input, init) => fetch(input, init),
  apiKey: () => process.env.OPENFANG_API_KEY?.trim() || undefined,
  openExternal: (url) => shell.openExternal(url),
  log: (line) => console.log(`[integrations] ${line}`),
});

export function integrationsHandlers() {
  return {
    'integrations:status': async () => client.status(),
    'integrations:add': async (_e: unknown, args: { id: string }) => client.add(args.id),
    'integrations:anmelden': async (_e: unknown, args: { id: string }) => client.anmelden(args.id),
    'integrations:abmelden': async (_e: unknown, args: { id: string }) => client.abmelden(args.id),
    'integrations:schluessel': async (_e: unknown, args: { id: string }) => client.schluessel(args.id),
    'integrations:neuVerbinden': async (_e: unknown, args: { id: string }) => client.neuVerbinden(args.id),
    'integrations:entfernen': async (_e: unknown, args: { id: string }) => client.entfernen(args.id),
    'integrations:freigabenOeffnen': async () => client.freigabenOeffnen(),
  } as const;
}

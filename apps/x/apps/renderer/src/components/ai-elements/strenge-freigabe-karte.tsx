// Modified for VibeMind (Flissel/rowboat vibemind): new file (Konzept-Fläche Teil B, Task 7).
// Rückfrage vor der Übergabe eines Videokonzepts an die Werkbank. Alle Werte stammen aus der Anfrage, die die
// Laufzeit aus der Datei gebaut hat, und erscheinen nur als Text (React-Kinder, nie HTML). Kein „immer erlauben".
"use client";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { quietRowContainerClass, quietRowTriggerClass, quietRowGlyphSlotClass } from "@/components/ai-elements/tool";
import { CheckIcon, ShieldQuestionIcon, XIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { KonzeptUebergabe, UEBERGABE_HINWEIS } from "@x/shared/dist/strenge-freigabe.js";

export type StrengeFreigabeKarteProps = ComponentProps<"div"> & {
  /** `request.uebergabe` der Freigabe-Anfrage (ungeprüft; die Karte prüft selbst). */
  uebergabe: unknown;
  onApprove?: () => void;
  onDeny?: () => void;
  isProcessing?: boolean;
  response?: "approve" | "deny" | null;
};

const Zeile = ({ name, wert }: { name: string; wert: string }) => (
  <div className="flex min-w-0 gap-2">
    <dt className="shrink-0 text-muted-foreground">{name}</dt>
    <dd className="min-w-0 break-words">{wert}</dd>
  </div>
);

export const StrengeFreigabeKarte = ({
  className,
  uebergabe,
  onApprove,
  onDeny,
  isProcessing = false,
  response = null,
  ...props
}: StrengeFreigabeKarteProps) => {
  const geprueft = KonzeptUebergabe.safeParse(uebergabe);
  const u = geprueft.success ? geprueft.data : null;

  if (response !== null) {
    return (
      <div className={cn(quietRowContainerClass, className)} {...props}>
        <div className={quietRowTriggerClass}>
          <span className={quietRowGlyphSlotClass}>
            {response !== "approve" && <span className="size-1.5 rounded-full bg-red-600 dark:bg-red-500" />}
          </span>
          <span className="shrink-0 font-medium text-muted-foreground">
            {response === "approve" ? "Übergeben" : "Nicht übergeben"}
          </span>
          {u && <span className="min-w-0 truncate text-muted-foreground">{u.thema}</span>}
        </div>
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label="Übergabe an die Video-Werkbank"
      className={cn(
        "not-prose my-1 w-full rounded-[10px] border border-l-2 border-l-amber-500/70 px-3 py-2 text-[13px]",
        className,
      )}
      {...props}
    >
      <div className="flex items-center gap-2.5">
        <ShieldQuestionIcon className="size-3.5 shrink-0 text-amber-600 dark:text-amber-500" />
        <p className="font-medium">Konzept an die Video-Werkbank übergeben?</p>
      </div>
      {u ? (
        <>
          <dl className="mt-2 flex flex-col gap-0.5">
            <Zeile name="Ziel" wert={u.ziel} />
            <Zeile name="Konzept" wert={u.pfad} />
            <Zeile name="Thema" wert={u.thema} />
            <Zeile name="Länge" wert={`${u.minuten} Minuten`} />
            <Zeile name="Stufen" wert={String(u.stufen)} />
            <Zeile name="Szenen" wert={String(u.szenen)} />
          </dl>
          {u.auftrag !== null && (
            <p className="mt-2">{`Es gibt schon den Auftrag ${u.auftrag}; es entsteht ein neuer.`}</p>
          )}
          <p className="mt-2 text-muted-foreground">{UEBERGABE_HINWEIS}</p>
        </>
      ) : (
        <p className="mt-2 text-muted-foreground">Die Rückfrage ist unvollständig. So lässt sich nichts übergeben.</p>
      )}
      <div className="mt-2 flex items-center justify-end gap-1.5">
        {u && (
          <Button
            variant="default"
            size="sm"
            onClick={onApprove}
            disabled={isProcessing}
            className="h-7 rounded-full px-3 text-xs"
          >
            <CheckIcon className="size-3.5" />
            Ja, übergeben
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          onClick={onDeny}
          disabled={isProcessing}
          className="h-7 rounded-full px-3 text-xs text-red-600 hover:bg-red-500/10 hover:text-red-600 dark:text-red-500"
        >
          <XIcon className="size-3.5" />
          Nein
        </Button>
      </div>
    </div>
  );
};
